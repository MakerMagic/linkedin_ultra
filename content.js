/**
 * content.js — инкрементальный скрапер LinkedIn Connections.
 *
 * Исправлено в v0.4:
 *   1. Селекторы переписаны на устойчивый подход (href + aria-label)
 *   2. Ожидание новых карточек через MutationObserver (не polling)
 *   3. Heartbeat каждые 5 сек — Dashboard видит что скрипт жив
 *   4. Ответ на PING от Background для проверки инжекции
 *   5. Ожидание первых карточек при старте (SPA грузит их асинхронно)
 */

(function () {
    'use strict';
  
    // ========================================================
    // КОНФИГУРАЦИЯ
    // ========================================================
    const CFG = {
      maxEmptyCycles:  5,     // Сколько раз подряд нет новых → стоп
      waitAfterScroll: 7000,  // Макс. ожидание новых элементов (мс)
      waitInitial:     12000, // Макс. ожидание первых карточек (мс)
      heartbeatInterval: 5000 // Как часто пишем heartbeat (мс)
    };
  
    // ========================================================
    // СОСТОЯНИЕ
    // ========================================================
    let isRunning = false;
    let heartbeatTimer = null;
  
    /**
     * Set нормализованных URL — дедупликация ВНУТРИ сессии.
     * При старте дополняется данными из chrome.storage (между сессиями).
     */
    const seenUrls = new Set();
  
    // ========================================================
    // ОТВЕТ НА PING (для background.js)
    // ========================================================
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'PING') {
        sendResponse({ alive: true, isRunning });
      }
    });
  
    // ========================================================
    // УТИЛИТЫ
    // ========================================================
  
    /**
     * Нормализует href в канонический URL профиля.
     * /in/john-doe?... → https://www.linkedin.com/in/john-doe
     */
    function normalizeUrl(href) {
      if (!href) return null;
      try {
        const base = href.startsWith('http')
          ? href
          : 'https://www.linkedin.com' + href;
        const u = new URL(base);
        const m = u.pathname.match(/^\/in\/([^/?#]+)/);
        return m ? 'https://www.linkedin.com/in/' + m[1] : null;
      } catch { return null; }
    }
  
    /**
     * Случайная задержка в мс.
     */
    function delay(min, max) {
      return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
    }
  
    /**
     * Скролл вниз с рандомной амплитудой — имитация человека.
     */
    function humanScroll() {
      const factor = 0.55 + Math.random() * 0.9; // 55–145% высоты экрана
      window.scrollBy({ top: Math.round(window.innerHeight * factor), behavior: 'smooth' });
    }
  
    // ========================================================
    // ИЗВЛЕЧЕНИЕ ИМЕНИ
    // ========================================================
  
    /**
     * LinkedIn часто кладёт имя в aria-label ссылки:
     *   "View John Doe's profile" → "John Doe"
     *   "Просмотреть профиль: John Doe" → "John Doe"
     */
    function nameFromAriaLabel(label) {
      if (!label) return null;
      // EN: "View X's profile" | "View X profile"
      let m = label.match(/^view\s+(.+?)(?:'s)?\s+profile$/i);
      if (m) return m[1].trim();
      // RU
      m = label.match(/просмотреть профиль[:\s]+(.+)/i);
      if (m) return m[1].trim();
      return null;
    }
  
    /**
     * Текст элемента без скрытых sr-only спанов.
     */
    function cleanText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll(
        '.sr-only, .visually-hidden, [class*="visually-hidden"]'
      ).forEach(n => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
  
    // ========================================================
    // ПОИСК ПРОФИЛЕЙ В DOM
    // ========================================================
  
    /**
     * Возвращает ВСЕ <a href="/in/..."> ссылки на странице,
     * исключая навигацию (хедер, сайдбар).
     *
     * Почему не querySelectorAll('.mn-connection-card'):
     *   LinkedIn постоянно меняет имена классов.
     *   Поиск по href="/in/" + фильтрация nav — стабильнее.
     */
    function findProfileLinks() {
      const result = [];
      for (const a of document.querySelectorAll('a[href*="/in/"]')) {
        const href = a.getAttribute('href') || '';
        // Только /in/что-то (не /interest/, /insights/, etc.)
        if (!href.match(/\/in\/[^/?#]{2,}/)) continue;
        // Исключаем навигационные зоны
        if (a.closest('header, .global-nav, [role="navigation"], .nav, #global-nav')) continue;
        result.push(a);
      }
      return result;
    }
  
    /**
     * Собирает НОВЫЕ контакты (не в seenUrls).
     * Использует несколько стратегий извлечения имени.
     */
    function harvestNewContacts() {
      const batch = [];
  
      for (const link of findProfileLinks()) {
        const profileUrl = normalizeUrl(link.getAttribute('href'));
        if (!profileUrl || seenUrls.has(profileUrl)) continue;
  
        // ——— Стратегии извлечения имени (по убыванию надёжности) ———
  
        let fullName = null;
  
        // 1. aria-label на самой ссылке (самый надёжный)
        fullName = nameFromAriaLabel(link.getAttribute('aria-label'));
  
        // 2. Дочерний элемент с классом *name* или *title*
        if (!fullName) {
          const nameEl = link.querySelector(
            '[class*="name"], [class*="title-text"], [class*="person-name"]'
          );
          if (nameEl) fullName = cleanText(nameEl);
        }
  
        // 3. Родительская карточка (li/div) → ищем в ней
        if (!fullName) {
          const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
          if (card) {
            const nameEl = card.querySelector(
              '[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title'
            );
            if (nameEl) fullName = cleanText(nameEl);
          }
        }
  
        // 4. alt у аватара (img) рядом с ссылкой
        if (!fullName) {
          const card2 = link.closest('li, [class*="card"]');
          if (card2) {
            const img = card2.querySelector('img[alt]:not([alt=""])');
            if (img) fullName = (img.getAttribute('alt') || '').trim();
          }
        }
  
        // 5. Текст самой ссылки (чистый)
        if (!fullName) fullName = cleanText(link);
  
        // ——— Валидация имени ———
        if (!fullName || fullName.length < 2) continue;
        // Технические строки — пропустить
        if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more)$/i.test(fullName)) continue;
  
        seenUrls.add(profileUrl);
        batch.push({
          profileUrl,
          fullName
          // Архитектура позволяет легко добавить:
          // title:    null,
          // company:  null,
          // location: null,
        });
      }
  
      return batch;
    }
  
    // ========================================================
    // ОЖИДАНИЕ НОВЫХ КАРТОЧЕК (MutationObserver)
    // ========================================================
  
    /**
     * Ждёт появления на странице НОВЫХ ссылок на профили
     * (сверх currentCount). Использует MutationObserver — не polling.
     *
     * @param {number} currentCount — сколько ссылок СЕЙЧАС
     * @param {number} timeoutMs
     * @returns {Promise<'appeared'|'timeout'>}
     */
    function waitForMoreLinks(currentCount, timeoutMs) {
      return new Promise(resolve => {
        // Уже появились?
        if (findProfileLinks().length > currentCount) {
          resolve('appeared');
          return;
        }
  
        let settled = false;
  
        const finish = (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          obs.disconnect();
          resolve(reason);
        };
  
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
  
        const obs = new MutationObserver(() => {
          if (findProfileLinks().length > currentCount) finish('appeared');
        });
  
        // subtree:true — LinkedIn добавляет карточки в глубокие узлы
        obs.observe(document.body, { childList: true, subtree: true });
      });
    }
  
    // ========================================================
    // HEARTBEAT
    // ========================================================
  
    /**
     * Пока скрипт работает — пишем timestamp в storage каждые 5 сек.
     * Dashboard по нему определяет «жив ли content script».
     */
    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        chrome.storage.local.set({ crm_heartbeat: Date.now() });
      }, CFG.heartbeatInterval);
    }
  
    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  
    // ========================================================
    // ГЛАВНЫЙ ЦИКЛ
    // ========================================================
  
    async function runScrapeLoop() {
      let emptyCycles = 0;
  
      // 1. Загружаем уже сохранённые → дедупликация между сессиями
      const stored = await chrome.storage.local.get(['crm_contacts']);
      const existing = Array.isArray(stored.crm_contacts) ? stored.crm_contacts : [];
      existing.forEach(c => { if (c.profileUrl) seenUrls.add(c.profileUrl); });
      console.log(`[CRM] Старт цикла. В базе: ${existing.length}. URL в seenUrls: ${seenUrls.size}`);
  
      startHeartbeat();
  
      // 2. Ждём первых карточек (SPA грузит асинхронно)
      if (findProfileLinks().length === 0) {
        console.log('[CRM] Ждём первых карточек...');
        const ready = await waitForMoreLinks(0, CFG.waitInitial);
        if (ready === 'timeout') {
          console.warn('[CRM] Первые карточки не появились за', CFG.waitInitial, 'мс');
          // Не останавливаемся — может быть частично загружено
        }
      }
  
      // 3. Первый урожай (до любого скролла)
      const firstBatch = harvestNewContacts();
      let allContacts = [...existing, ...firstBatch];
  
      if (firstBatch.length > 0) {
        await chrome.storage.local.set({
          crm_contacts: allContacts,
          crm_sync_count: allContacts.length,
          crm_sync_status: 'running'
        });
        console.log(`[CRM] Первый урожай: ${firstBatch.length}. Всего: ${allContacts.length}`);
      } else {
        console.log(`[CRM] Первый урожай пустой. Видно ссылок: ${findProfileLinks().length}`);
      }
  
      // 4. Цикл скролла
      while (isRunning) {
  
        // Проверяем команду STOP (пользователь нажал кнопку)
        const snap = await chrome.storage.local.get(['crm_sync_command']);
        if (snap.crm_sync_command === 'stop') {
          console.log('[CRM] Получена команда STOP');
          break;
        }
  
        const countBefore = findProfileLinks().length;
        console.log(`[CRM] Скролл. Ссылок сейчас: ${countBefore}`);
  
        // Скролл вниз
        humanScroll();
  
        // Ждём появления НОВЫХ ссылок (MutationObserver, не polling)
        const waitResult = await waitForMoreLinks(countBefore, CFG.waitAfterScroll);
  
        if (waitResult === 'timeout') {
          emptyCycles++;
          console.log(`[CRM] Новых нет (${emptyCycles}/${CFG.maxEmptyCycles})`);
        } else {
          emptyCycles = 0;
          // Ждём чуть больше — LinkedIn рендерит постепенно
          await delay(300, 700);
        }
  
        // Собираем новые контакты
        const batch = harvestNewContacts();
        if (batch.length > 0) {
          const freshSnap = await chrome.storage.local.get(['crm_contacts']);
          allContacts = [
            ...(Array.isArray(freshSnap.crm_contacts) ? freshSnap.crm_contacts : []),
            ...batch
          ];
          await chrome.storage.local.set({
            crm_contacts: allContacts,
            crm_sync_count: allContacts.length,
            crm_sync_status: 'running'
          });
          console.log(`[CRM] +${batch.length}. Итого: ${allContacts.length}`);
        }
  
        // Дно страницы?
        if (emptyCycles >= CFG.maxEmptyCycles) {
          console.log('[CRM] Достигнуто дно страницы — завершаем');
          break;
        }
  
        // Человеческая пауза между скроллами
        const longPause = Math.random() < 0.15;
        await delay(
          longPause ? 3500 : 1200,
          longPause ? 6500 : 2800
        );
      }
  
      // 5. Завершение
      stopHeartbeat();
      const finalStatus = isRunning ? 'done' : 'stopped';
      isRunning = false;
  
      await chrome.storage.local.set({
        crm_sync_status: finalStatus,
        crm_sync_command: null
      });
  
      console.log('[CRM] Цикл завершён. Статус:', finalStatus);
    }
  
    // ========================================================
    // КОМАНДЫ ЧЕРЕЗ chrome.storage (от Dashboard)
    // ========================================================
  
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.crm_sync_command) return;
      const cmd = changes.crm_sync_command.newValue;
  
      if (cmd === 'start' && !isRunning) {
        console.log('[CRM] Команда START');
        isRunning = true;
        runScrapeLoop().catch(err => {
          console.error('[CRM] Критическая ошибка в цикле:', err);
          stopHeartbeat();
          isRunning = false;
          chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
        });
      }
  
      if (cmd === 'stop' && isRunning) {
        console.log('[CRM] Команда STOP — устанавливаем флаг');
        isRunning = false;
        // Статус обновится на 'stopped' когда цикл сделает break
      }
    });
  
    // ========================================================
    // ВОССТАНОВЛЕНИЕ ПОСЛЕ ПЕРЕЗАГРУЗКИ СТРАНИЦЫ
    // ========================================================
    chrome.storage.local
      .get(['crm_sync_command', 'crm_sync_status'])
      .then(data => {
        if (
          data.crm_sync_command === 'start' &&
          data.crm_sync_status === 'running' &&
          !isRunning
        ) {
          console.log('[CRM] Восстанавливаем прерванную синхронизацию...');
          isRunning = true;
          runScrapeLoop().catch(console.error);
        }
      });
  
    console.log('[CRM] content.js инициализирован:', location.href);
  
  })();