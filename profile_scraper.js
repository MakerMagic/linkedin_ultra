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
    if (typeof el === 'string') {
      return el.replace(/\s+/g, ' ').trim();
    }
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], .sr-only, .visually-hidden, [class*="hidden"]').forEach(n => n.remove());
    let text = clone.textContent || '';
    // Remove flag emojis (common in LinkedIn locations)
    text = text.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '');
    text = text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
    return text.replace(/\s+/g, ' ').trim();
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
   * Также исключаем медиа/галереи (ссылки с изображениями опыта).
   */
  function isIconLink(a) {
    // Иконка компании: есть svg/img но нет параграфа с текстом
    const hasVisual = !!(a.querySelector('svg') || a.querySelector('img'));
    const hasText = !!a.querySelector('p');
    if (hasVisual && !hasText) return true;
    
    // Медиа-галерея: ссылка содержит только изображение/видео без job title
    const isMediaGallery = a.querySelector('img, video, [class*="carousel"], [class*="gallery"]');
    const hasJobText = a.textContent?.toLowerCase().includes('founder') || 
                       a.textContent?.toLowerCase().includes('ceo') ||
                       a.textContent?.toLowerCase().includes('manager') ||
                       a.querySelector('p, h3, h4, span:not(:empty)');
    if (isMediaGallery && !hasJobText) return true;
    
    return false;
  }

  // ── Выбор нужной ссылки ────────────────────────────────────────────────

  /**
   * Берём первую значимую ссылку — это самая свежая запись (верхняя в списке).
   * Фильтруем иконки компаний и медиа-галереи.
   */
  function getTargetLink(section) {
    if (!section) return null;
    const links = Array.from(section.querySelectorAll('a'));
    console.log(`[CRM Scraper] Links in section: ${links.length}`);

    // Убираем иконки и медиа
    const meaningful = links.filter(a => !isIconLink(a));
    console.log(`[CRM Scraper] Meaningful links: ${meaningful.length}`);

    if (meaningful.length === 0) return null;

    // Берём ПЕРВУЮ (index 0) — самая свежая запись в Experience/Education
    return meaningful[0];
  }

  // ── Location extraction from TopCard ───────────────────────────────────

  /**
   * Check if text looks like a location (not a job title)
   */
  function isLocationLike(text) {
    if (!text || text.length < 2 || text.length > 100) return false;
    const t = text.toLowerCase();
    // Exclude job titles
    const jobPatterns = [' at ', ' @', ' | ', ' - ', 'looking for', 'open to work', 'hiring', 'ceo', 'founder', 'manager', 'director', 'engineer', 'specialist', 'consultant', 'freelance'];
    if (jobPatterns.some(p => t.includes(p))) return false;
    // Location indicators: comma, "Greater Area", countries, simple city
    return /,/.test(text) ||
           /\b(greater|metro|metropolitan)\s+\w+\s+area/i.test(text) ||
           /\b(usa|united states|uk|canada|india|china|germany|france|russia|brazil|australia|japan|spain|italy|netherlands|sweden|norway|denmark|finland|poland|ukraine|belarus|kazakhstan|turkey|uae|dubai|singapore|hong kong|mexico|argentina|south africa|egypt|israel|indonesia|malaysia|thailand|vietnam|philippines|uzbekistan|georgia|romania|bulgaria|serbia|croatia|greece|portugal|ireland|iceland|estonia|latvia|lithuania|belgium|switzerland|austria|czech|slovakia|hungary)\b/i.test(text) ||
           /^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}$/.test(text);
  }

  /**
   * Extract location from TopCard section using 4 fallback strategies
   */
  function extractLocation(topCardSection) {
    if (!topCardSection) return '';
    try {
      // Strategy 1: Location icon indicator (most reliable)
      const locationIcon = topCardSection.querySelector('svg[data-supported-dps*="16"], svg[aria-label*="location"], li-icon[type*="location"], .artdeco-icon[aria-label*="location"], svg:has(~ span):has([d*="M12"])');
      if (locationIcon) {
        let container = locationIcon.closest('div, span, p');
        if (container) {
          const text = cleanText(container);
          if (isLocationLike(text)) {
            console.log('[CRM Scraper] Location found (icon strategy):', text);
            return text;
          }
        }
        const parent = locationIcon.parentElement;
        if (parent) {
          const text = cleanText(parent);
          if (isLocationLike(text)) {
            console.log('[CRM Scraper] Location found (icon parent):', text);
            return text;
          }
        }
      }

      // Strategy 2: Search all paragraphs with strict filtering
      const paragraphs = topCardSection.querySelectorAll('p, span.text-body-small, .pv-top-card__list-item, [class*="location"], [class*="geo"]');
      for (const p of paragraphs) {
        const text = cleanText(p);
        if (isLocationLike(text) && !p.closest('button, a[role="button"]')) {
          console.log('[CRM Scraper] Location found (paragraph search):', text);
          return text;
        }
      }

      // Strategy 3: Contact-info previous sibling (legacy layout)
      const contactLink = topCardSection.querySelector('a[href*="contact-info"]');
      if (contactLink) {
        const contactP = contactLink.closest('p, div');
        if (contactP) {
          const prevP = contactP.previousElementSibling;
          if (prevP && (prevP.tagName === 'P' || prevP.tagName === 'DIV' || prevP.tagName === 'SPAN')) {
            const text = cleanText(prevP);
            if (isLocationLike(text)) {
              console.log('[CRM Scraper] Location found (contact-info prev):', text);
              return text;
            }
          }
        }
      }

      // Strategy 4: Broad search in nested containers
      const containers = topCardSection.querySelectorAll('div, span');
      for (const el of containers) {
        const text = cleanText(el);
        // Extra strict: must have comma OR country/region pattern
        if (isLocationLike(text) && 
            text.length > 2 && text.length < 60 &&
            !el.closest('button, [role="button"]') &&
            (/,/.test(text) || /\b(greater|metropolitan|region|area|usa|uk|canada|india|germany|france|denmark|sweden|norway|ukraine|kazakhstan)\b/i.test(text))) {
          console.log('[CRM Scraper] Location found (broad search):', text);
          return text;
        }
      }

      console.log('[CRM Scraper] No location found in TopCard');
      return '';
    } catch (err) {
      console.error('[CRM Scraper] Error extracting location:', err);
      return '';
    }
  }

  // ── Основной парсинг ──────────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Scraping profile ===');
    console.log('[CRM Scraper] URL:', window.location.href);

    let jobTitle = '';
    let company  = '';
    let school   = '';
    let major    = '';
    let locationText = '';

    const { experienceSection, educationSection, topCardSection } = findSections();

    // ── Location from TopCard ──
    if (topCardSection) {
      locationText = extractLocation(topCardSection);
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

    const result = { jobTitle, company, school, major, location: locationText };
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
      chrome.runtime.sendMessage({ type: 'PROFILE_DATA', data: result, url: window.location.href })
        .catch(err => console.warn('[CRM Scraper] sendMessage error:', err));
    }
  })();

})();