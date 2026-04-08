/**
 * profile_scraper.js — LinkedIn CRM v2.4
 *
 * Парсинг по ТЗ:
 *   - componentKey: ExperienceTopLevelSection / EducationTopLevelSection
 *   - Fallback (русский UI): "Опыт", "Опыт работы", "Образование"
 *   - Берём все <a> в секции, игнорируем первый (иконка), берём второй / последний
 *   - a.querySelectorAll("p") → p[0]=jobTitle, p[1]=company / p[0]=school, p[1]=major
 *   - Пустые значения = "" (не null)
 *
 * Fast scroll:
 *   - window.scrollTo(0, scrollHeight) несколько раз, delay 200–400ms
 *   - до стабилизации scrollHeight
 */
(function () {
  'use strict';

  // ── Очистка текста ────────────────────────────────────────────────────

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], .sr-only, .visually-hidden').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── Fast scroll ────────────────────────────────────────────────────────

  /**
   * Быстрый скролл до конца страницы.
   * LinkedIn лениво рендерит секции — нужно прокрутить чтобы они появились.
   * Шаг 200–400ms, максимум 6 итераций, стоп при стабилизации высоты.
   */
  async function fastScroll() {
    console.log('[CRM Scraper] Fast scroll started');
    let prevHeight = -1;
    let iterations = 0;

    while (iterations < 6) {
      const h = document.body.scrollHeight;
      window.scrollTo(0, h);
      const delay = 200 + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
      const newH = document.body.scrollHeight;
      console.log(`[CRM Scraper] Fast scroll ${iterations + 1}: ${prevHeight} → ${h} → ${newH}`);
      if (newH === h && iterations > 0) { console.log('[CRM Scraper] Fast scroll completed'); break; }
      prevHeight = h;
      iterations++;
    }

    // Возвращаемся наверх
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Ожидание секций ────────────────────────────────────────────────────

  function waitForSections(timeoutMs) {
    return new Promise(resolve => {
      function isReady() {
        if (document.querySelector('[componentKey*="Experience"],[componentkey*="experience"]')) return true;
        if (document.querySelector('[componentKey*="Education"],[componentkey*="education"]')) return true;
        if (document.querySelector('#experience,#education')) return true;
        return Array.from(document.querySelectorAll('h2,h3')).some(h => {
          const t = (h.textContent || '').trim().toLowerCase();
          return t === 'опыт' || t === 'опыт работы' || t === 'образование' || t === 'experience' || t === 'education';
        });
      }

      if (isReady()) { resolve(); return; }

      let done = false;
      function finish() {
        if (done) return; done = true;
        clearInterval(pollId); obs.disconnect(); clearTimeout(timer);
        resolve();
      }

      const pollId = setInterval(() => { if (isReady()) finish(); }, 300);
      const obs    = new MutationObserver(() => { if (isReady()) finish(); });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer  = setTimeout(finish, timeoutMs || 10000);
    });
  }

  // ── Поиск секций ──────────────────────────────────────────────────────

  function findSections() {
    let experienceSection = null;
    let educationSection  = null;

    // Метод 1: componentKey
    for (const el of document.querySelectorAll('[componentKey],[componentkey]')) {
      const ck = (el.getAttribute('componentKey') || el.getAttribute('componentkey') || '').toLowerCase();
      if (!experienceSection && ck.includes('experience')) {
        experienceSection = el;
        console.log('[CRM Scraper] ✅ Experience (componentKey)');
      }
      if (!educationSection && ck.includes('education')) {
        educationSection = el;
        console.log('[CRM Scraper] ✅ Education (componentKey)');
      }
    }

    // Метод 2: заголовок (русский/английский)
    if (!experienceSection || !educationSection) {
      for (const h of document.querySelectorAll('h2,h3,[id]')) {
        const text = (h.textContent || '').trim().toLowerCase();
        const id   = (h.id || '').toLowerCase();

        if (!experienceSection && (
          text === 'опыт' || text === 'опыт работы' || text === 'experience' ||
          id === 'experience' || id.includes('experience')
        )) {
          experienceSection = h.closest('section') || h.parentElement?.parentElement || h;
          console.log('[CRM Scraper] ✅ Experience (heading):', text || id);
        }

        if (!educationSection && (
          text === 'образование' || text === 'education' ||
          id === 'education' || id.includes('education')
        )) {
          educationSection = h.closest('section') || h.parentElement?.parentElement || h;
          console.log('[CRM Scraper] ✅ Education (heading):', text || id);
        }
      }
    }

    return { experienceSection, educationSection };
  }

  // ── Проверка: иконка ссылка ────────────────────────────────────────────

  /**
   * Первый <a> в секции = иконка компании (содержит svg/img но не содержит <p>).
   */
  function isIconLink(a) {
    return (a.querySelector('svg') || a.querySelector('img')) && !a.querySelector('p');
  }

  // ── Выбор нужной ссылки ────────────────────────────────────────────────

  /**
   * По ТЗ: берём все <a>, игнорируем первый (иконка), берём второй/последний.
   * "Второй" означает второй в порядке DOM — для актуальной записи.
   * Если второй отсутствует — берём последний.
   */
  function getTargetLink(section) {
    if (!section) return null;
    const links = Array.from(section.querySelectorAll('a'));
    console.log(`[CRM Scraper] Links in section: ${links.length}`);

    // Фильтруем иконки
    const meaningful = links.filter(a => !isIconLink(a));
    console.log(`[CRM Scraper] Meaningful links: ${meaningful.length}`);

    if (meaningful.length === 0) return null;

    // Берём второй (индекс 1) — или последний если только один
    return meaningful.length >= 2 ? meaningful[1] : meaningful[meaningful.length - 1];
  }

  // ── Основной парсинг ──────────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Scraping profile ===');
    console.log('[CRM Scraper] URL:', location.href);

    let jobTitle = '';
    let company  = '';
    let school   = '';
    let major    = '';

    const { experienceSection, educationSection } = findSections();

    // ── Experience: p[0]=jobTitle, p[1]=company ──
    if (experienceSection) {
      const link = getTargetLink(experienceSection);
      if (link) {
        const paras = Array.from(link.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
        console.log('[CRM Scraper] Experience paragraphs:', paras);
        if (paras[0]) jobTitle = paras[0];
        if (paras[1]) company  = paras[1];
      } else {
        console.warn('[CRM Scraper] No meaningful link in Experience section');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Experience section not found');
    }

    // ── Education: p[0]=school, p[1]=major ──
    if (educationSection) {
      const link = getTargetLink(educationSection);
      if (link) {
        const paras = Array.from(link.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
        console.log('[CRM Scraper] Education paragraphs:', paras);
        if (paras[0]) school = paras[0];
        if (paras[1]) major  = paras[1];
      } else {
        console.warn('[CRM Scraper] No meaningful link in Education section');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Education section not found');
    }

    // ── Fallback: occupation subtitle в шапке ──
    if (!jobTitle && !company && !school) {
      const el =
        document.querySelector('.pv-text-details__left-panel .text-body-medium') ||
        document.querySelector('.ph5 .text-body-medium');
      if (el) {
        const text = cleanText(el);
        const atIdx = text.toLowerCase().indexOf(' at ');
        if (atIdx !== -1) {
          jobTitle = text.slice(0, atIdx).trim();
          company  = text.slice(atIdx + 4).trim();
        } else if (text) {
          jobTitle = text;
        }
        console.log('[CRM Scraper] Fallback:', { jobTitle, company });
      }
    }

    // Пустые значения = "" (не null/undefined)
    const result = { jobTitle, company, school, major };
    console.log('[CRM Scraper] Final result:', result);
    return result;
  }

  // ── Основной поток ─────────────────────────────────────────────────────

  (async () => {
    // 1. Fast scroll — загружаем lazy секции
    await fastScroll();

    // 2. Ждём секций (MutationObserver + polling)
    await waitForSections(8000);

    // 3. Пауза после скролла
    await new Promise(r => setTimeout(r, 500));

    // 4. Парсим
    const result = scrapeProfile();

    // 5. Отправляем в background.js
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'PROFILE_DATA', data: result, url: location.href })
        .catch(err => console.warn('[CRM Scraper] sendMessage error:', err));
    }
  })();

})();