/**
 * profile_scraper.js — LinkedIn CRM v1.5
 *
 * Инжектируется в фоновую вкладку профиля LinkedIn.
 * Извлекает jobTitle, company, school по логике из ТЗ.
 * Возвращает данные через chrome.runtime.sendMessage.
 *
 * Только чтение DOM — никаких мутаций.
 */
(function () {
    'use strict';
   
    // Убираем скрытые sr-only спаны из текста
    function cleanText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]')
        .forEach(n => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
   
    // Проверяет является ли текст учебным заведением
    function isSchool(text) {
      return /university|college|school|institute|academy|polytechnic|seminary|лицей|колледж|университет|институт|академия/i.test(text);
    }
   
    /**
     * Основная функция парсинга профиля.
     * Логика строго по ТЗ:
     *
     * ExperienceTopLevelSection:
     *   p.ba487acf (основной текст) + isSchool → institution (место работы = учебное заведение)
     *   p.ba487acf (основной текст) + !isSchool → jobTitle
     *   p.dd3e351e (вторичный текст)            → company
     *
     * EducationTopLevelSection:
     *   p.ba487acf (основной текст)             → school (учебное заведение)
     *   p.dd3e351e (вторичный текст)            → major (факультет/специальность)
     */
    function scrapeProfile() {
      let jobTitle = null;
      let company  = null;
      let school   = null;
   
      // Ищем все секции с componentKey
      const allSections = document.querySelectorAll('[componentKey], [componentkey]');
   
      for (const section of allSections) {
        const ck =
          section.getAttribute('componentKey') ||
          section.getAttribute('componentkey') || '';
   
        const isExp = /ExperienceTopLevelSection/i.test(ck);
        const isEdu = /EducationTopLevelSection/i.test(ck);
   
        if (!isExp && !isEdu) continue;
   
        // Основной текст (жирный): классы из ТЗ — ba487acf
        // Ищем все p с этим классом внутри секции
        const boldEls = section.querySelectorAll('p[class*="ba487acf"]');
        // Вторичный текст: dd3e351e
        const subEls  = section.querySelectorAll('p[class*="dd3e351e"]');
   
        if (isExp) {
          // Первый жирный элемент в секции опыта = должность или учебное заведение (работа)
          const boldEl = boldEls[0];
          if (boldEl && !jobTitle) {
            const t = cleanText(boldEl);
            if (t) {
              if (isSchool(t) && !school) school = t;
              else jobTitle = t;
            }
          }
   
          // Первый вторичный = компания
          const subEl = subEls[0];
          if (subEl && !company) {
            const c = cleanText(subEl);
            if (c) company = c;
          }
        }
   
        if (isEdu) {
          // Первый жирный = учебное заведение
          const schoolEl = boldEls[0];
          if (schoolEl && !school) {
            const s = cleanText(schoolEl);
            if (s) school = s;
          }
          // Вторичный = специальность (major) — сохраняем в company если company пустая
          // По ТЗ major = null если нет, поэтому просто игнорируем для CSV
        }
      }
   
      // Fallback — occupation subtitle если секции не найдены
      if (!jobTitle && !company && !school) {
        const occupationEl =
          document.querySelector('.pv-text-details__left-panel .text-body-medium') ||
          document.querySelector('.ph5 .text-body-medium')                          ||
          document.querySelector('[class*="text-body-medium"]');
   
        if (occupationEl) {
          const text = cleanText(occupationEl);
          const atIdx = text.toLowerCase().indexOf(' at ');
          if (atIdx !== -1) {
            const title = text.slice(0, atIdx).trim();
            const org   = text.slice(atIdx + 4).trim();
            if (isSchool(org)) {
              jobTitle = title || null;
              school   = org;
            } else {
              jobTitle = title || null;
              company  = org;
            }
          } else if (isSchool(text)) {
            school = text;
          } else if (text) {
            jobTitle = text;
          }
        }
      }
   
      return {
        jobTitle: jobTitle || null,
        company:  company  || null,
        school:   school   || null
      };
    }
   
    // Ждём загрузки основного контента перед парсингом
    function waitForContent(timeoutMs = 8000) {
      return new Promise(resolve => {
        // Если уже загружено — сразу
        if (document.querySelector('[componentKey], [componentkey]') ||
            document.querySelector('.pv-text-details__left-panel')) {
          resolve();
          return;
        }
   
        const obs = new MutationObserver(() => {
          if (document.querySelector('[componentKey], [componentkey]') ||
              document.querySelector('.pv-text-details__left-panel')) {
            obs.disconnect();
            clearTimeout(timer);
            resolve();
          }
        });
   
        obs.observe(document.body, { childList: true, subtree: true });
        const timer = setTimeout(() => { obs.disconnect(); resolve(); }, timeoutMs);
      });
    }
   
    // Основной поток
    (async () => {
      await waitForContent();
   
      // Небольшая пауза — LinkedIn рендерит постепенно
      await new Promise(r => setTimeout(r, 800));
   
      const result = scrapeProfile();
      console.log('[CRM Scraper] Результат:', result);
   
      // Возвращаем данные в background через sendMessage
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage({
          type:   'PROFILE_DATA',
          data:   result,
          url:    location.href
        }).catch(() => {});
      }
    })();
   
  })();
   