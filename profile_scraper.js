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
   * Проверяет, является ли ссылка иконкой или медиа-вложением (не job entry).
   * Исключаем:
   * 1. Иконки компании (svg/img без <p>)
   * 2. Медиа-вложения (ссылки с img внутри — как "Пурифайеры WOTA" на скриншоте)
   * 3. Ссылки без /company/ в href (не job entries)
   */
  function isIconLink(a) {
    const href = a.getAttribute('href') || '';
    
    const hasImg = !!a.querySelector('img');
    const hasSvg = !!a.querySelector('svg');
    const hasP   = !!a.querySelector('p');
    
    // Случай 1: иконка (svg/img без текстового параграфа)
    if ((hasSvg || hasImg) && !hasP) return true;
    
    // Случай 2: медиа-вложение (img + p в одном <a> = attachment-карточка)
    // Как "Пурифайеры WOTA" — превью с картинкой и подписью
    // НО: исключаем образовательные учреждения (/school/) — у них логотипы с названием
    const isSchoolLink = href.includes('/school/');
    if (hasImg && hasP && !isSchoolLink) return true;
    
    // Не job/education entry: нет /company/ И /school/ в ссылке
    const isCompanyOrSchool = href.includes('/company/') || isSchoolLink;
    if (!isCompanyOrSchool) return true;
    
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

  /**
   * Проверяет, является ли ссылка заголовком группы (company header)
   * с длительностью работы (типа "2 yrs 7 mos" или "Dec 2024 - Present")
   */
  function isCompanyHeaderLink(link) {
    const paragraphs = Array.from(link.querySelectorAll('p'));
    if (paragraphs.length < 2) return false;
    
    const p1Text = cleanText(paragraphs[1]);
    
    // Company header содержит длительность работы в компании (общая)
    // Примеры: "3 yrs 5 mos", "Full-time · 3 yrs 5 mos", "2 years 10 months"
    // Job entry содержит даты: "Oct 2025 - Present · 7 mos", "Dec 2022 - Sep 2025"
    const hasDurationPattern = /\d+\s*(yrs?|mos?|years?|months?)/i.test(p1Text);
    const hasDateRange = /\w{3,}\s+\d{4}\s*-\s*(Present|\w{3,}\s+\d{4})/i.test(p1Text);
    
    // Если есть длительность и НЕТ дат конкретных (Jan 2023 - Dec 2024) — это company header
    return hasDurationPattern && !hasDateRange;
  }

  /**
   * Парсим Experience с учетом множественных позиций в одной компании.
   * LinkedIn группирует позиции: первая ссылка = company header, остальные = позиции.
   * @returns {{jobTitle: string, company: string} | null}
   */
  function getExperienceData(experienceSection) {
    if (!experienceSection) return null;
    
    // Находим все ссылки на компании с параграфами
    const allLinks = Array.from(experienceSection.querySelectorAll('a'));
    const companyLinks = allLinks.filter(a => {
      // Ссылка на компанию и имеет текстовые параграфы
      const href = a.getAttribute('href') || '';
      const hasParagraphs = a.querySelectorAll('p').length > 0;
      return href.includes('/company/') && hasParagraphs && !isIconLink(a);
    });
    
    console.log(`[CRM Scraper] Company links in Experience: ${companyLinks.length}`);
    
    if (companyLinks.length === 0) {
      // Fallback на стандартную логику
      const link = getTargetLink(experienceSection);
      if (!link) return null;
      const paras = Array.from(link.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
      return { jobTitle: paras[0] || '', company: paras[1] || '' };
    }
    
    // Проверяем, является ли первая ссылка company header (группированный опыт)
    const firstLink = companyLinks[0];
    const isGrouped = isCompanyHeaderLink(firstLink);
    
    if (companyLinks.length === 1 || !isGrouped) {
      // Обычный случай: одна позиция или не-группированный опыт
      // p[0] = jobTitle, p[1] = company
      const paras = Array.from(firstLink.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
      return { jobTitle: paras[0] || '', company: paras[1] || '' };
    }
    
    // Группированный опыт: [0] = company header (Emerge, 2 yrs 7 mos), [1] = первая позиция
    const companyParas = Array.from(firstLink.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
    const company = companyParas[0] || '';
    
    // Берем вторую ссылку как должность
    const jobLink = companyLinks[1];
    const jobParas = Array.from(jobLink.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
    const jobTitle = jobParas[0] || '';
    
    console.log(`[CRM Scraper] Grouped experience: company="${company}", job="${jobTitle}"`);
    return { jobTitle, company };
  }

  // ── Основной парсинг ──────────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Scraping profile ===');
    console.log('[CRM Scraper] URL:', window.location.href);

    let jobTitle = '';
    let company  = '';
    let school   = '';
    let major    = '';

    const { experienceSection, educationSection } = findSections();

    // ── Experience: обрабатываем множественные позиции в одной компании ──
    if (experienceSection) {
      const expData = getExperienceData(experienceSection);
      if (expData) {
        jobTitle = expData.jobTitle;
        company = expData.company;
        console.log('[CRM Scraper] Experience parsed:', { jobTitle, company });
      } else {
        console.warn('[CRM Scraper] No data in Experience section');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Experience section not found');
    }

    // ── Education: ищем запись без годов в major ──
    if (educationSection) {
      // Находим все ссылки на учебные заведения
      const eduLinks = Array.from(educationSection.querySelectorAll('a')).filter(a => {
        const href = a.getAttribute('href') || '';
        return (href.includes('/school/') || href.includes('/company/')) && !isIconLink(a);
      });
      
      console.log(`[CRM Scraper] Education links: ${eduLinks.length}`);
      
      // Проверяем, содержит ли текст годы (4 цифры или 2025-2025)
      function containsYears(text) {
        if (!text) return false;
        return /\b\d{4}\b/.test(text) || /\d{4}\s*[-–]\s*\d{4}/.test(text);
      }
      
      // Ищем первую запись без годов в major
      for (const link of eduLinks) {
        const paras = Array.from(link.querySelectorAll('p'))
          .map(p => cleanText(p))
          .filter(Boolean);
        
        if (paras.length >= 2 && !containsYears(paras[1])) {
          school = paras[0] || '';
          major = paras[1] || '';
          console.log('[CRM Scraper] Education found (no years):', { school, major });
          break;
        }
      }
      
      // Если все записи с годами — берем первую, major = 'not found'
      if (!school && eduLinks.length > 0) {
        const firstLink = eduLinks[0];
        const paras = Array.from(firstLink.querySelectorAll('p'))
          .map(p => cleanText(p))
          .filter(Boolean);
        school = paras[0] || '';
        major = containsYears(paras[1]) ? 'not found' : (paras[1] || '');
        console.log('[CRM Scraper] Education (years in major):', { school, major });
      }
      
      if (!school) {
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

    const result = { jobTitle, company, school, major };
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
