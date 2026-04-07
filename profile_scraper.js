/**
 * profile_scraper.js — LinkedIn CRM v2.1
 *
 * БАГ 1 ИСПРАВЛЕН:
 *   Проблема: CSS-классы типа "ba487acf" — хеши, которые LinkedIn меняет при каждом деплое.
 *   Решение: ищем по структуре DOM, aria-атрибутам и семантике — стабильно.
 *
 *   Порядок стратегий:
 *     1. componentKey секции → структурные потомки (h3/span для title, span для company)
 *     2. data-view-name атрибуты
 *     3. Поиск по aria-label у ссылок внутри секций
 *     4. Fallback: occupation subtitle в шапке профиля
 *
 *   Ожидание: MutationObserver + polling каждые 300мс (до 12 сек)
 *   DEBUG: подробные console.log на каждом шаге
 */
(function () {
  'use strict';

  // ── Утилиты ────────────────────────────────────────────────────────────

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Убираем sr-only, скрытые span с дублирующим текстом
    clone.querySelectorAll(
      '.sr-only, .visually-hidden, [class*="visually-hidden"], [aria-hidden="true"]'
    ).forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isSchool(text) {
    return /university|college|school|institute|academy|polytechnic|seminary|мгу|нгу|спбгу|лицей|колледж|университет|институт|академия/i.test(text);
  }

  // ── Ожидание загрузки DOM ────────────────────────────────────────────

  /**
   * Ждёт появления секций Experience или Education на странице.
   * Использует MutationObserver + polling каждые 300мс.
   * Таймаут 12 секунд — достаточно для медленных соединений.
   */
  function waitForProfileSections(timeoutMs) {
    return new Promise(resolve => {
      const SELECTORS = [
        '[data-view-name="profile-component-entity"]',
        '[componentKey*="Experience"]',
        '[componentKey*="Education"]',
        '.experience-section',
        '#experience',
        '#education',
        'section[data-section="experience"]',
        '.pv-profile-card'
      ];

      function isReady() {
        return SELECTORS.some(sel => {
          try { return document.querySelector(sel) !== null; } catch { return false; }
        });
      }

      if (isReady()) {
        console.log('[CRM Scraper] Секции уже загружены');
        resolve('ready');
        return;
      }

      console.log('[CRM Scraper] Ждём загрузки секций профиля...');

      // Polling каждые 300мс — надёжнее чем только MutationObserver для SPA
      const pollInterval = setInterval(() => {
        if (isReady()) {
          clearInterval(pollInterval);
          obs.disconnect();
          clearTimeout(timer);
          console.log('[CRM Scraper] Секции появились (polling)');
          resolve('ready');
        }
      }, 300);

      const obs = new MutationObserver(() => {
        if (isReady()) {
          clearInterval(pollInterval);
          obs.disconnect();
          clearTimeout(timer);
          console.log('[CRM Scraper] Секции появились (MutationObserver)');
          resolve('ready');
        }
      });

      obs.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        clearInterval(pollInterval);
        obs.disconnect();
        console.warn('[CRM Scraper] Таймаут ожидания секций — парсим что есть');
        resolve('timeout');
      }, timeoutMs || 12000);
    });
  }

  // ── СТРАТЕГИЯ 1: componentKey секции ─────────────────────────────────

  /**
   * Ищет секции по componentKey (Experience/Education).
   * Внутри каждой секции ищет карточки по data-view-name или структуре.
   */
  function scrapeByComponentKey() {
    let jobTitle = null, company = null, school = null;

    const allNodes = document.querySelectorAll('[componentKey], [componentkey]');
    console.log(`[CRM Scraper] componentKey узлов: ${allNodes.length}`);

    for (const node of allNodes) {
      const ck = (node.getAttribute('componentKey') || node.getAttribute('componentkey') || '').toLowerCase();

      const isExp = ck.includes('experience');
      const isEdu = ck.includes('education');

      if (!isExp && !isEdu) continue;

      console.log(`[CRM Scraper] Секция: ${ck.slice(0, 60)}`);

      // Ищем карточки записей внутри секции
      const items = node.querySelectorAll(
        '[data-view-name="profile-component-entity"], li, .pvs-list__item--line-separated'
      );

      console.log(`[CRM Scraper]   Карточек: ${items.length}`);

      // Берём первую карточку (текущее место работы/учёбы)
      const firstItem = items.length > 0 ? items[0] : node;

      // Заголовок: ищем по нескольким стратегиям
      let titleText = null;

      // 1a. Первый span/div внутри ссылки на профиль компании
      const titleLink = firstItem.querySelector('a[href*="/company/"], a[href*="/school/"]');
      if (titleLink) {
        // Заголовок — элемент ДО ссылки на компанию
        const titleEl = firstItem.querySelector('[aria-hidden="true"]');
        if (titleEl) titleText = cleanText(titleEl);
      }

      // 1b. Первый span с role="heading" или aria-level
      if (!titleText) {
        const headingEl = firstItem.querySelector('[role="heading"], [aria-level]');
        if (headingEl) titleText = cleanText(headingEl);
      }

      // 1c. Структурный поиск: первый "жирный" текст (обычно это title)
      if (!titleText) {
        // LinkedIn использует t-bold / t-16 / t-14 для заголовков
        const boldEl = firstItem.querySelector(
          '[class*="t-bold"], [class*="t-16"], span.mr1, .mr1'
        );
        if (boldEl) titleText = cleanText(boldEl);
      }

      // 1d. Первый span с достаточной длиной (>2 слов)
      if (!titleText) {
        for (const span of firstItem.querySelectorAll('span[aria-hidden="true"]')) {
          const t = cleanText(span);
          if (t && t.split(' ').length >= 2 && t.length > 5) {
            titleText = t;
            break;
          }
        }
      }

      if (titleText) {
        console.log(`[CRM Scraper]   titleText: "${titleText}"`);
      }

      // Компания/организация: ссылка на company или school
      let orgText = null;
      const orgLink = firstItem.querySelector('a[href*="/company/"], a[href*="/school/"]');
      if (orgLink) {
        orgText = cleanText(orgLink);
        console.log(`[CRM Scraper]   orgText (link): "${orgText}"`);
      }

      // Fallback для org: второй span[aria-hidden="true"]
      if (!orgText) {
        const spans = Array.from(firstItem.querySelectorAll('span[aria-hidden="true"]'));
        if (spans.length >= 2) {
          orgText = cleanText(spans[1]);
          console.log(`[CRM Scraper]   orgText (span[1]): "${orgText}"`);
        }
      }

      if (isExp) {
        if (titleText && !jobTitle) jobTitle = titleText;
        if (orgText && !company)   company  = orgText;
        // Если orgText выглядит как учебное заведение
        if (orgText && isSchool(orgText) && !school) school = orgText;
      }

      if (isEdu) {
        if (orgText && !school) {
          school = orgText;
        } else if (titleText && !school && isSchool(titleText)) {
          school = titleText;
        } else if (titleText && !school) {
          school = titleText; // учебное заведение = название организации в Education
        }
      }

      // Если оба поля заполнены — дальше не ищем
      if (jobTitle && company) break;
    }

    return { jobTitle, company, school };
  }

  // ── СТРАТЕГИЯ 2: data-view-name карточки ─────────────────────────────

  function scrapeByDataViewName() {
    let jobTitle = null, company = null, school = null;

    // LinkedIn использует data-view-name="profile-component-entity" для карточек опыта
    const entities = document.querySelectorAll('[data-view-name="profile-component-entity"]');
    console.log(`[CRM Scraper] data-view-name entities: ${entities.length}`);

    // Ищем секцию с id="experience" или "education" как родителя
    for (const entity of entities) {
      const section = entity.closest('#experience, #education, [id*="experience"], [id*="education"]');
      if (!section) continue;

      const isExp = section.id.toLowerCase().includes('experience');
      const isEdu = section.id.toLowerCase().includes('education');

      const spans = Array.from(entity.querySelectorAll('span[aria-hidden="true"]')).map(s => cleanText(s)).filter(Boolean);
      console.log(`[CRM Scraper]   spans: ${JSON.stringify(spans.slice(0, 4))}`);

      if (isExp && spans.length >= 1) {
        if (!jobTitle && spans[0]) jobTitle = spans[0];
        if (!company  && spans[1]) company  = spans[1];
        break;
      }
      if (isEdu && spans.length >= 1) {
        if (!school && spans[0]) school = spans[0];
        break;
      }
    }

    return { jobTitle, company, school };
  }

  // ── СТРАТЕГИЯ 3: шапка профиля (occupation subtitle) ─────────────────

  function scrapeByHeader() {
    // Occupation line — разные классы в разных версиях LinkedIn
    const selectors = [
      '.pv-text-details__left-panel .text-body-medium',
      '.ph5 .text-body-medium',
      '[class*="text-body-medium"]:not([class*="t-black--light"])',
      '.pv-top-card--list .pv-entity__summary-info h2',
      '[data-generated-suggestion-target]'
    ];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = cleanText(el);
        if (!text || text.length < 3) continue;

        console.log(`[CRM Scraper] Header selector "${sel}": "${text}"`);

        const atIdx = text.toLowerCase().indexOf(' at ');
        if (atIdx !== -1) {
          const title = text.slice(0, atIdx).trim();
          const org   = text.slice(atIdx + 4).trim();
          return {
            jobTitle: title  || null,
            company:  isSchool(org) ? null  : (org || null),
            school:   isSchool(org) ? org   : null
          };
        }
        // Без " at " — просто должность или место учёбы
        if (isSchool(text)) return { jobTitle: null, company: null, school: text };
        return { jobTitle: text, company: null, school: null };
      } catch { /* пропуск */ }
    }

    return { jobTitle: null, company: null, school: null };
  }

  // ── СТРАТЕГИЯ 4: meta/title теги ─────────────────────────────────────

  function scrapeByMeta() {
    // LinkedIn иногда пишет должность в <title>: "John Doe | Senior Engineer at Google"
    const title = document.title || '';
    const m = title.match(/[|–-]\s*(.+?)\s+at\s+(.+?)(\s*[|–-]|$)/i);
    if (m) {
      console.log(`[CRM Scraper] Meta title match: "${m[1]}" at "${m[2]}"`);
      return {
        jobTitle: m[1].trim() || null,
        company:  isSchool(m[2].trim()) ? null : (m[2].trim() || null),
        school:   isSchool(m[2].trim()) ? m[2].trim() : null
      };
    }
    return { jobTitle: null, company: null, school: null };
  }

  // ── ОБЪЕДИНЕНИЕ СТРАТЕГИЙ ─────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Начинаем парсинг профиля ===');
    console.log('[CRM Scraper] URL:', location.href);
    console.log('[CRM Scraper] Title:', document.title);
    console.log('[CRM Scraper] componentKey count:', document.querySelectorAll('[componentKey],[componentkey]').length);
    console.log('[CRM Scraper] #experience:', !!document.querySelector('#experience'));
    console.log('[CRM Scraper] #education:', !!document.querySelector('#education'));

    // Пробуем стратегии по убыванию надёжности
    let result = scrapeByComponentKey();
    console.log('[CRM Scraper] Стратегия 1 (componentKey):', JSON.stringify(result));

    if (!result.jobTitle && !result.company && !result.school) {
      result = scrapeByDataViewName();
      console.log('[CRM Scraper] Стратегия 2 (data-view-name):', JSON.stringify(result));
    }

    if (!result.jobTitle && !result.company && !result.school) {
      result = scrapeByHeader();
      console.log('[CRM Scraper] Стратегия 3 (header):', JSON.stringify(result));
    }

    if (!result.jobTitle && !result.company && !result.school) {
      result = scrapeByMeta();
      console.log('[CRM Scraper] Стратегия 4 (meta):', JSON.stringify(result));
    }

    if (!result.jobTitle && !result.company && !result.school) {
      console.warn('[CRM Scraper] ⚠️ Ни одна стратегия не дала результат');
      console.warn('[CRM Scraper] Доступные componentKey:', Array.from(
        document.querySelectorAll('[componentKey]')
      ).map(el => el.getAttribute('componentKey')).slice(0, 10));
    }

    console.log('[CRM Scraper] Итог:', JSON.stringify(result));
    return {
      jobTitle: result.jobTitle || null,
      company:  result.company  || null,
      school:   result.school   || null
    };
  }

  // ── Основной поток ─────────────────────────────────────────────────────

  (async () => {
    // Ждём загрузки секций (MutationObserver + polling)
    await waitForProfileSections(12000);

    // Дополнительная пауза — LinkedIn SPA рендерит контент постепенно
    await new Promise(r => setTimeout(r, 1200));

    const result = scrapeProfile();

    // Отправляем данные в background.js
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'PROFILE_DATA',
        data: result,
        url:  location.href
      }).catch(err => console.warn('[CRM Scraper] sendMessage failed:', err));
    } else {
      console.warn('[CRM Scraper] chrome.runtime недоступен');
    }
  })();

})();