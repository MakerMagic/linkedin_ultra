/**
 * profile_scraper.js — LinkedIn CRM v2.2
 *
 * Исправлено:
 *   1. Не используем className — только структуру DOM и атрибуты
 *   2. Рекурсивно собираем <p> через все вложенные <div> внутри <a>
 *   3. Пропускаем первый <a> (иконка компании с <svg>)
 *   4. Берём ПОСЛЕДНИЙ валидный <a> в секции
 *   5. Fallback по заголовкам для русского интерфейса LinkedIn
 */
(function () {
  'use strict';

  // ── Очистка текста (убираем скрытые элементы) ────────────────────────────

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Убираем sr-only и aria-hidden спаны — они дублируют текст для скринридеров
    clone.querySelectorAll('[aria-hidden="true"], .sr-only, .visually-hidden').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── Рекурсивный сбор всех <p> внутри элемента ───────────────────────────

  /**
   * Проходит через все вложенные <div> внутри корневого элемента
   * и собирает все найденные <p> в порядке их появления.
   *
   * Структура LinkedIn:
   *   <a>
   *     <div>           ← первый уровень вложенности
   *       <div>         ← второй уровень
   *         <p>Должность</p>
   *         <p>Компания</p>
   *       </div>
   *     </div>
   *   </a>
   */
  function collectParagraphs(root) {
    // querySelectorAll обходит дерево рекурсивно сам по себе
    return Array.from(root.querySelectorAll('p'))
      .map(p => cleanText(p))
      .filter(t => t.length > 0);
  }

  // ── Проверка: содержит ли <a> только иконку (SVG без текста) ────────────

  /**
   * Первый <a> в секции LinkedIn — это иконка компании/учебного заведения.
   * Признаки: содержит <svg> И не содержит текстовых <p>.
   */
  function isIconLink(a) {
    const hasSvg  = a.querySelector('svg') !== null;
    const hasImg  = a.querySelector('img') !== null;
    const hasPara = a.querySelector('p') !== null;

    // Иконка: есть svg или img, но нет параграфов с текстом
    return (hasSvg || hasImg) && !hasPara;
  }

  // ── Поиск всех <a> в секции, исключая первый-иконку ─────────────────────

  /**
   * Возвращает список <a> внутри секции.
   * Первый <a> с иконкой (svg/img без <p>) — пропускается.
   * Из оставшихся берём ПОСЛЕДНИЙ — это актуальное место работы/учёбы.
   */
  function getLastMeaningfulLink(section) {
    const links = Array.from(section.querySelectorAll('a'));

    if (links.length === 0) return null;

    // Фильтруем: убираем иконки (первые ссылки с svg/img без параграфов)
    const meaningful = links.filter(a => !isIconLink(a));

    console.log(`[CRM Scraper]   Ссылок всего: ${links.length}, осмысленных: ${meaningful.length}`);

    if (meaningful.length === 0) return null;

    // Берём ПОСЛЕДНИЙ осмысленный <a> — актуальная запись
    return meaningful[meaningful.length - 1];
  }

  // ── Поиск секции Experience/Education ────────────────────────────────────

  /**
   * Ищет секцию по двум методам:
   *
   * Метод 1 (приоритет): componentKey атрибут
   *   - ExperienceTopLevelSection → секция опыта
   *   - EducationTopLevelSection  → секция образования
   *
   * Метод 2 (fallback для русского UI): заголовок секции
   *   - "Опыт" / "Опыт работы" / "Experience" → опыт
   *   - "Образование" / "Education"            → образование
   */
  function findSections() {
    let experienceSection = null;
    let educationSection  = null;

    // ── Метод 1: componentKey ──
    const allWithKey = document.querySelectorAll('[componentKey], [componentkey]');

    for (const el of allWithKey) {
      const ck = el.getAttribute('componentKey') || el.getAttribute('componentkey') || '';

      if (/ExperienceTopLevelSection/i.test(ck) && !experienceSection) {
        experienceSection = el;
        console.log('[CRM Scraper] ✅ Найдена секция опыта (componentKey):', ck.slice(0, 80));
      }

      if (/EducationTopLevelSection/i.test(ck) && !educationSection) {
        educationSection = el;
        console.log('[CRM Scraper] ✅ Найдена секция образования (componentKey):', ck.slice(0, 80));
      }
    }

    // ── Метод 2: fallback по заголовку (русский / английский UI) ──
    if (!experienceSection || !educationSection) {
      // Ищем h2, span или div которые содержат заголовок секции
      const headingCandidates = document.querySelectorAll('h2, section > div > span, [id]');

      for (const el of headingCandidates) {
        const text = (el.textContent || '').trim().toLowerCase();

        // Опыт
        if (!experienceSection && (
          text === 'опыт' ||
          text === 'опыт работы' ||
          text === 'experience' ||
          el.id === 'experience'
        )) {
          // Поднимаемся до секции
          experienceSection = el.closest('section') || el.parentElement?.parentElement || el;
          console.log('[CRM Scraper] ✅ Найдена секция опыта (заголовок):', text);
        }

        // Образование
        if (!educationSection && (
          text === 'образование' ||
          text === 'education' ||
          el.id === 'education'
        )) {
          educationSection = el.closest('section') || el.parentElement?.parentElement || el;
          console.log('[CRM Scraper] ✅ Найдена секция образования (заголовок):', text);
        }
      }
    }

    // ── Метод 3: поиск по id секций ──
    if (!experienceSection) {
      experienceSection =
        document.querySelector('#experience') ||
        document.querySelector('[id*="experience"]') ||
        null;
      if (experienceSection) console.log('[CRM Scraper] ✅ Найдена секция опыта (id)');
    }

    if (!educationSection) {
      educationSection =
        document.querySelector('#education') ||
        document.querySelector('[id*="education"]') ||
        null;
      if (educationSection) console.log('[CRM Scraper] ✅ Найдена секция образования (id)');
    }

    return { experienceSection, educationSection };
  }

  // ── Основной парсинг ─────────────────────────────────────────────────────

  function scrapeProfile() {
    console.log('[CRM Scraper] === Начало парсинга ===');
    console.log('[CRM Scraper] URL:', location.href);
    console.log('[CRM Scraper] Заголовок:', document.title);

    let jobTitle = null;
    let company  = null;
    let school   = null;

    const { experienceSection, educationSection } = findSections();

    // ── Секция опыта ──
    if (experienceSection) {
      console.log('[CRM Scraper] Парсим секцию опыта...');

      const link = getLastMeaningfulLink(experienceSection);

      if (link) {
        const paragraphs = collectParagraphs(link);
        console.log('[CRM Scraper]   Параграфы в последнем <a>:', paragraphs);

        if (paragraphs[0]) jobTitle = paragraphs[0]; // должность
        if (paragraphs[1]) company  = paragraphs[1]; // компания
      } else {
        console.warn('[CRM Scraper]   Осмысленный <a> в секции опыта не найден');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Секция опыта не найдена');
    }

    // ── Секция образования ──
    if (educationSection) {
      console.log('[CRM Scraper] Парсим секцию образования...');

      const link = getLastMeaningfulLink(educationSection);

      if (link) {
        const paragraphs = collectParagraphs(link);
        console.log('[CRM Scraper]   Параграфы в последнем <a>:', paragraphs);

        if (paragraphs[0]) school = paragraphs[0]; // учебное заведение
        // paragraphs[1] — major/специальность, по ТЗ не сохраняем (null)
      } else {
        console.warn('[CRM Scraper]   Осмысленный <a> в секции образования не найден');
      }
    } else {
      console.warn('[CRM Scraper] ⚠️ Секция образования не найдена');
    }

    // ── Fallback: шапка профиля (occupation subtitle) ──
    // Используется когда секции не найдены вообще
    if (!jobTitle && !company && !school) {
      console.log('[CRM Scraper] Fallback: парсим шапку профиля...');

      const occupationEl =
        document.querySelector('.pv-text-details__left-panel .text-body-medium') ||
        document.querySelector('.ph5 .text-body-medium')                          ||
        document.querySelector('[data-view-name="profile-card"] .text-body-medium');

      if (occupationEl) {
        const text = cleanText(occupationEl);
        console.log('[CRM Scraper]   Occupation text:', text);

        const atIdx = text.toLowerCase().indexOf(' at ');
        if (atIdx !== -1) {
          jobTitle = text.slice(0, atIdx).trim() || null;
          company  = text.slice(atIdx + 4).trim() || null;
        } else if (text) {
          jobTitle = text;
        }
      }
    }

    const result = {
      jobTitle: jobTitle || null,
      company:  company  || null,
      school:   school   || null
    };

    console.log('[CRM Scraper] Итоговый результат:', result);
    return result;
  }

  // ── Ожидание появления секций в DOM ─────────────────────────────────────

  /**
   * Ждёт появления секций Experience или Education.
   * LinkedIn — SPA, секции рендерятся асинхронно после загрузки страницы.
   * Комбинируем MutationObserver + polling каждые 300мс, таймаут 10 сек.
   */
  function waitForSections(timeoutMs) {
    return new Promise(resolve => {
      function isReady() {
        // Проверяем оба метода определения секций
        const hasCK =
          document.querySelector('[componentKey*="Experience"], [componentkey*="experience"]') ||
          document.querySelector('[componentKey*="Education"],  [componentkey*="education"]');

        const hasId =
          document.querySelector('#experience') ||
          document.querySelector('#education');

        const hasHeader = Array.from(document.querySelectorAll('h2')).some(h => {
          const t = h.textContent.trim().toLowerCase();
          return t === 'опыт' || t === 'образование' || t === 'experience' || t === 'education';
        });

        return !!(hasCK || hasId || hasHeader);
      }

      if (isReady()) {
        console.log('[CRM Scraper] Секции уже доступны');
        resolve();
        return;
      }

      console.log('[CRM Scraper] Ждём появления секций...');

      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        clearInterval(pollId);
        obs.disconnect();
        clearTimeout(timerId);
        resolve();
      }

      // Polling каждые 300мс
      const pollId = setInterval(() => {
        if (isReady()) {
          console.log('[CRM Scraper] Секции появились (polling)');
          finish();
        }
      }, 300);

      // MutationObserver — реагирует мгновенно
      const obs = new MutationObserver(() => {
        if (isReady()) {
          console.log('[CRM Scraper] Секции появились (MutationObserver)');
          finish();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      // Таймаут — парсим что есть
      const timerId = setTimeout(() => {
        console.warn('[CRM Scraper] Таймаут — парсим что загрузилось');
        finish();
      }, timeoutMs || 10000);
    });
  }

  // ── Основной поток ───────────────────────────────────────────────────────

  (async () => {
    // 1. Ждём появления секций
    await waitForSections(10000);

    // 2. Дополнительная пауза — LinkedIn рендерит контент постепенно
    await new Promise(r => setTimeout(r, 1000));

    // 3. Парсим профиль
    const result = scrapeProfile();

    // 4. Отправляем результат в background.js
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'PROFILE_DATA',
        data: result,
        url:  location.href
      }).catch(err => console.warn('[CRM Scraper] sendMessage error:', err));
    } else {
      console.warn('[CRM Scraper] chrome.runtime недоступен — расширение перезагружалось?');
    }
  })();

})();