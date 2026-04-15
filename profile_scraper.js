/**
 * profile_scraper.js — LinkedIn CRM v2.5
 *
 * Инжектируется ПОСЛЕ того как background.js уже выполнил фиксированный scroll
 * (5 итераций × 600мс через executeScript func).
 * К этому моменту секции Experience/Education уже подгружены.
 *
 * Задача скрипта: только ПАРСИНГ, не скролл.
 *
 * Логика парсинга (по ТЗ):
 *   - componentKey: ExperienceTopLevelSection / EducationTopLevelSection
 *   - Fallback: заголовок h2 ("Опыт", "Образование", "Experience", "Education")
 *   - Все <a> в секции → игнорируем первый (иконка) → берём второй/последний
 *   - a.querySelectorAll("p") → p[0]=jobTitle, p[1]=company (Experience)
 *                             → p[0]=school,   p[1]=major   (Education)
 *   - Пустые значения = ""
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

  // ── Ожидание секций ────────────────────────────────────────────────────

  /**
   * Ждём секции с помощью MutationObserver + polling.
   * Scroll уже выполнен background.js — секции должны появиться быстро.
   * Таймаут 8 сек на случай медленного соединения.
   */
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
      const timer  = setTimeout(finish, timeoutMs || 8000);
    });
  }

  // ── Поиск секций ──────────────────────────────────────────────────────

  function findSections() {
    let experienceSection = null;
    let educationSection  = null;
    let topCardSection    = null;

    // Метод 1: componentKey (приоритет)
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
      if (!topCardSection && ck.includes('pv-top-card')) {
        topCardSection = el;
        console.log('[CRM Scraper] ✅ TopCard (componentKey)');
      }
    }

    // Метод 2: заголовок h2/h3 (fallback для русского UI)
    if (!experienceSection || !educationSection || !topCardSection) {
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

    return { experienceSection, educationSection, topCardSection };
  }

  // ── Проверка: иконка-ссылка ────────────────────────────────────────────

  /**
   * Первый <a> в секции — иконка компании (svg/img без <p>).
   * Такие ссылки игнорируем.
   */
  function isIconLink(a) {
    return !!(a.querySelector('svg') || a.querySelector('img')) && !a.querySelector('p');
  }

  // ── Выбор нужной ссылки ────────────────────────────────────────────────

  /**
   * По ТЗ: берём все <a>, пропускаем первый (иконка), берём второй (индекс 1).
   * Если второй отсутствует — берём последний.
   */
  function getTargetLink(section) {
    if (!section) return null;
    const links = Array.from(section.querySelectorAll('a'));
    console.log(`[CRM Scraper] Links in section: ${links.length}`);

    // Убираем иконки
    const meaningful = links.filter(a => !isIconLink(a));
    console.log(`[CRM Scraper] Meaningful links: ${meaningful.length}`);

    if (meaningful.length === 0) return null;

    // Берём второй (index 1) — если только один, берём его
    return meaningful.length >= 2 ? meaningful[1] : meaningful[meaningful.length - 1];
  }

  // ── Location extraction from TopCard ───────────────────────────────────

  /**
   * Extract location from TopCard section.
   * Structure: TopCard → nested divs → deepest div → first <p> = location
   * Returns empty string if not found.
   */
  function extractLocation(topCardSection) {
    if (!topCardSection) return '';

    try {
      // Strategy (relative DOM inside TopCard):
      // - find <a href*="contact-info">
      // - location can be:
      //   (A) in the same inline container as the link (text + link)
      //   (B) in text nodes / elements directly before the link
      //   (C) in previous sibling <p> elements (older layout)

      const contactLink = topCardSection.querySelector('a[href*="contact-info"]');
      if (!contactLink) return '';

      const linkText = cleanText(contactLink);

      // (A) Closest container text minus the link label
      const container = contactLink.closest('p,span,div');
      if (container) {
        let t = cleanText(container);
        if (t) {
          // remove the link label (e.g., "Contact info")
          if (linkText) t = t.split(linkText).join(' ');
          t = t.replace(/\s+/g, ' ').trim();
          if (t) {
            console.log('[CRM Scraper] Location found:', t);
            return t;
          }
        }
      }

      // (B) Directly preceding nodes within the link's parent
      const parentEl = contactLink.parentElement;
      if (parentEl) {
        const bits = [];

        // Walk previous siblings (can include Text nodes)
        let n = contactLink.previousSibling;
        while (n) {
          if (n.nodeType === Node.TEXT_NODE) {
            const s = String(n.textContent || '').replace(/\s+/g, ' ').trim();
            if (s) bits.push(s);
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            const el = /** @type {HTMLElement} */ (n);
            if (!el.querySelector('a')) {
              const s = cleanText(el);
              if (s) bits.push(s);
            }
          }
          n = n.previousSibling;
        }

        const t = bits.reverse().join(' ').replace(/\s+/g, ' ').trim();
        if (t) {
          console.log('[CRM Scraper] Location found:', t);
          return t;
        }
      }

      // (C) Previous sibling <p> elements before the contact-info <p>
      const contactP = contactLink.closest('p');
      if (!contactP) return '';

      const candidates = [];
      let cur = contactP.previousElementSibling;
      while (cur) {
        if (cur.tagName !== 'P') break;
        if (!cur.querySelector('a')) {
          const text = cleanText(cur);
          if (text) candidates.push(text);
        }
        cur = cur.previousElementSibling;
      }

      if (!candidates.length) return '';

      // We walked backwards from the link; the farthest is the last collected.
      const location = candidates[candidates.length - 1];
      console.log('[CRM Scraper] Location found:', location);
      return location;
    } catch (err) {
      console.warn('[CRM Scraper] Location extraction error:', err);
      return '';
    }
  }

  // ── Основной парсинг ──────────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Scraping profile ===');
    console.log('[CRM Scraper] URL:', location.href);

    let jobTitle = '';
    let company  = '';
    let school   = '';
    let major    = '';
    let location = '';

    const { experienceSection, educationSection, topCardSection } = findSections();

    // ── Location from TopCard ──
    if (topCardSection) {
      location = extractLocation(topCardSection);
    } else {
      console.warn('[CRM Scraper] ⚠️ TopCard section not found');
    }

    // ── Experience: p[0]=jobTitle, p[1]=company ──
    if (experienceSection) {
      const link = getTargetLink(experienceSection);
      if (link) {
        const paras = Array.from(link.querySelectorAll('p'))
          .map(p => cleanText(p))
          .filter(Boolean);
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
        const paras = Array.from(link.querySelectorAll('p'))
          .map(p => cleanText(p))
          .filter(Boolean);
        console.log('[CRM Scraper] Education paragraphs:', paras);
        if (paras[0]) school = paras[0];
        if (paras[1]) major  = paras[1];
      } else {
        console.warn('[CRM Scraper] No meaningful link in Education section');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Education section not found');
    }

    // ── Fallback: occupation subtitle в шапке профиля ──
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

    const result = { jobTitle, company, school, major, location };
    console.log('[CRM Scraper] Profile parsed:', result);
    return result;
  }

  // ── Основной поток ─────────────────────────────────────────────────────

  (async () => {
    // Ждём секций (scroll уже сделан background.js до инжекта этого скрипта)
    await waitForSections(8000);

    // Небольшая пауза — React может батчить финальные обновления
    await new Promise(r => setTimeout(r, 400));

    // Парсим
    const result = scrapeProfile();

    // Отправляем в background.js
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'PROFILE_DATA', data: result, url: location.href })
        .catch(err => console.warn('[CRM Scraper] sendMessage error:', err));
    }
  })();

})();