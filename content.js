/**
 * content.js — LinkedIn CRM v0.6
 *
 * Ключевые исправления:
 *   1. Скролл через scrollTop + instant (работает на фоновой вкладке)
 *   2. StopToken — прерывает цикл немедленно, не ждёт конца await
 *   3. Инкрементальный сбор: новые контакты пишутся после каждого скролла
 *   4. Прогресс = собрано / total (total берём из заголовка LinkedIn)
 *   5. Одна фаза вместо двух — проще и надёжнее
 */
(function () {
    'use strict';
  
    // =====================================================================
    // КОНФИГУРАЦИЯ
    // =====================================================================
  
    const CFG = {
      scrollPxMin:       300,   // мс — минимальный шаг скролла (px)
      scrollPxMax:       700,   // мс — максимальный шаг скролла (px)
      pauseAfterScroll:  1500,  // мс — базовая пауза после скролла
      pauseJitter:       1500,  // мс — добавляется случайно (итого 1.5–3 сек)
      waitNewCardsMs:    4000,  // мс — ждём новых карточек через MutationObserver
      maxEmptyCycles:    5,     // N скроллов без новых карточек → конец
      heartbeatInterval: 4000   // мс — маяк жизни для dashboard
    };
  
    // =====================================================================
    // STOP TOKEN — единственный надёжный способ прервать async-цикл
    // =====================================================================
  
    /**
     * Создаём объект-токен. Любой await проверяет token.cancelled перед продолжением.
     * При отмене выбрасывается специальный класс — отличаем от реальных ошибок.
     */
    class CancelledError extends Error {
      constructor() { super('cancelled'); this.name = 'CancelledError'; }
    }
  
    function makeStopToken() {
      return { cancelled: false };
    }
  
    /**
     * Обёртка над setTimeout: сразу бросает CancelledError если токен уже отменён.
     */
    function delayOrCancel(ms, token) {
      return new Promise((resolve, reject) => {
        if (token.cancelled) { reject(new CancelledError()); return; }
        const id = setTimeout(() => {
          if (token.cancelled) reject(new CancelledError());
          else resolve();
        }, ms);
        // Если токен отменят во время ожидания — прерываем через 50 мс
        const check = setInterval(() => {
          if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }
        }, 50);
        // Чистим интервал после нормального завершения
        setTimeout(() => clearInterval(check), ms + 100);
      });
    }
  
    // =====================================================================
    // ГЛОБАЛЬНОЕ СОСТОЯНИЕ
    // =====================================================================
  
    let isRunning      = false;
    let currentToken   = null;   // активный StopToken
    let heartbeatTimer = null;
    const seenUrls     = new Set(); // дедупликация между запусками в рамках сессии
  
    // =====================================================================
    // УТИЛИТЫ
    // =====================================================================
  
    function randomInt(min, max) {
      return Math.floor(min + Math.random() * (max - min));
    }
  
    /**
     * Нормализует href → канонический URL профиля.
     * /in/john-doe?queryParam → https://www.linkedin.com/in/john-doe
     */
    function normalizeProfileUrl(href) {
      if (!href) return null;
      try {
        const base = href.startsWith('http')
          ? href
          : 'https://www.linkedin.com' + href;
        const m = new URL(base).pathname.match(/^\/in\/([^/?#]+)/);
        return m ? 'https://www.linkedin.com/in/' + m[1] : null;
      } catch { return null; }
    }
  
    /**
     * Извлекает имя из aria-label ссылки.
     * "View John Doe's profile" → "John Doe"
     * "Просмотреть профиль: John Doe" → "John Doe"
     */
    function nameFromAriaLabel(label) {
      if (!label) return null;
      let m = label.match(/^view\s+(.+?)(?:'s)?\s+profile$/i);
      if (m) return m[1].trim();
      m = label.match(/просмотреть профиль[:\s]+(.+)/i);
      if (m) return m[1].trim();
      return null;
    }
  
    /** Текст элемента без скрытых sr-only спанов */
    function cleanText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]')
        .forEach(n => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
  
    // =====================================================================
    // ПОЛУЧЕНИЕ TOTAL CONNECTIONS ИЗ UI LINKEDIN
    // =====================================================================
  
    /**
     * LinkedIn показывает "500+ connections" или "234 connections" в заголовке.
     * Парсим число. Если не нашли — возвращаем null (прогресс будет приблизительным).
     *
     * Варианты текста:
     *   "500+ connections"  → 500
     *   "234 connections"   → 234
     *   "1,234 connections" → 1234
     */
    function getTotalConnections() {
      // Пробуем несколько мест где LinkedIn может показывать счётчик
      const candidates = [
        // Заголовок раздела Connections
        document.querySelector('h1'),
        document.querySelector('.mn-connections__header'),
        // Breadcrumb или подзаголовок
        document.querySelector('[data-view-name="connections-list-header"]'),
        // Любой элемент с "connections" в тексте
        ...Array.from(document.querySelectorAll('span, p, h2, h3')).filter(el =>
          /\d.*connections?/i.test(el.textContent)
        )
      ].filter(Boolean);
  
      for (const el of candidates) {
        const text = el.textContent || '';
        const m = text.match(/([\d,]+)\+?\s*connections?/i);
        if (m) {
          const num = parseInt(m[1].replace(/,/g, ''), 10);
          if (num > 0) {
            console.log(`[CRM] Total connections найдено: ${num} (из "${text.trim().slice(0, 60)}")`);
            return num;
          }
        }
      }
  
      return null;
    }
  
    // =====================================================================
    // ПОИСК ССЫЛОК НА ПРОФИЛИ В DOM
    // =====================================================================
  
    /**
     * Все <a href="/in/..."> исключая навигацию.
     * Стабильнее поиска по классам — LinkedIn их постоянно меняет.
     */
    function findProfileLinks() {
      const links = [];
      for (const a of document.querySelectorAll('a[href*="/in/"]')) {
        const href = a.getAttribute('href') || '';
        if (!href.match(/\/in\/[^/?#]{2,}/)) continue;
        if (a.closest('header, .global-nav, [role="navigation"], #global-nav')) continue;
        links.push(a);
      }
      return links;
    }
  
    // =====================================================================
    // ИЗВЛЕЧЕНИЕ КОНТАКТА ИЗ ССЫЛКИ
    // =====================================================================
  
    function extractContact(link) {
      const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
      if (!profileUrl) return null;
  
      let fullName = null;
  
      // 1. aria-label — наиболее надёжный источник имени
      fullName = nameFromAriaLabel(link.getAttribute('aria-label'));
  
      // 2. Дочерний элемент с классом *name*
      if (!fullName) {
        const el = link.querySelector('[class*="name"], [class*="title-text"], [class*="person-name"]');
        if (el) fullName = cleanText(el);
      }
  
      // 3. Родительская карточка → ищем имя внутри
      if (!fullName) {
        const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
        if (card) {
          const el = card.querySelector('[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title');
          if (el) fullName = cleanText(el);
        }
      }
  
      // 4. Alt аватара в родительской карточке
      if (!fullName) {
        const card = link.closest('li, [class*="card"]');
        if (card) {
          const img = card.querySelector('img[alt]:not([alt=""])');
          if (img) fullName = (img.getAttribute('alt') || '').trim();
        }
      }
  
      // 5. Текст самой ссылки (запасной вариант)
      if (!fullName) fullName = cleanText(link);
  
      // Валидация
      if (!fullName || fullName.length < 2) return null;
      if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more|open)$/i.test(fullName)) return null;
  
      return { profileUrl, fullName };
    }
  
    // =====================================================================
    // ИНКРЕМЕНТАЛЬНЫЙ СБОР (во время скролла)
    // =====================================================================
  
    /**
     * Собирает новые контакты из текущего DOM.
     * Использует модульный seenUrls — не собирает дубликаты между итерациями.
     * @returns {Array} массив новых контактов
     */
    function harvestNewContacts() {
      const fresh = [];
      for (const link of findProfileLinks()) {
        const contact = extractContact(link);
        if (!contact) continue;
        if (seenUrls.has(contact.profileUrl)) continue;
        seenUrls.add(contact.profileUrl);
        fresh.push(contact);
      }
      return fresh;
    }
  
    // =====================================================================
    // ОЖИДАНИЕ НОВЫХ КАРТОЧЕК (MutationObserver — не polling)
    // =====================================================================
  
    /**
     * Ждёт появления новых ссылок сверх currentCount или истечения таймаута.
     * MutationObserver реагирует мгновенно при добавлении DOM-узлов.
     * @returns {Promise<'appeared'|'timeout'>}
     */
    function waitForNewCards(currentCount, timeoutMs, token) {
      return new Promise((resolve, reject) => {
        if (token.cancelled) { reject(new CancelledError()); return; }
  
        // Уже появились новые?
        if (findProfileLinks().length > currentCount) {
          resolve('appeared');
          return;
        }
  
        let done = false;
        const finish = (reason) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          obs.disconnect();
          if (token.cancelled) reject(new CancelledError());
          else resolve(reason);
        };
  
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        const cancelCheck = setInterval(() => {
          if (token.cancelled) finish('cancelled');
        }, 100);
  
        const obs = new MutationObserver(() => {
          if (findProfileLinks().length > currentCount) {
            clearInterval(cancelCheck);
            finish('appeared');
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
  
        // Чистим интервал когда промис resolve
        const origFinish = finish;
      });
    }
  
    // =====================================================================
    // СКРОЛЛ (работает на фоновой вкладке)
    // =====================================================================
  
    /**
     * LinkedIn грузит контакты при скролле контейнера ИЛИ window.
     * На фоновой вкладке 'smooth' игнорируется — используем 'instant'.
     * Пробуем оба варианта для надёжности.
     */
    function performScroll(px) {
      // Вариант 1: скроллим контейнер со списком (если LinkedIn рендерит внутри него)
      const listContainer =
        document.querySelector('.scaffold-finite-scroll__content') ||
        document.querySelector('.mn-connections__list') ||
        document.querySelector('[data-view-name="connections-list"]') ||
        document.querySelector('main');
  
      if (listContainer && listContainer.scrollHeight > listContainer.clientHeight) {
        listContainer.scrollTop += px;
      }
  
      // Вариант 2: скроллим window — основной способ для большинства версий LI
      window.scrollBy({ top: px, behavior: 'instant' });
  
      console.log(`[CRM] Скролл на ${px}px. scrollY=${window.scrollY}. bodyH=${document.body.scrollHeight}`);
    }
  
    // =====================================================================
    // РЕПОРТ ПРОГРЕССА В STORAGE
    // =====================================================================
  
    /**
     * @param {number} collected — сколько собрано сейчас
     * @param {number|null} total — всего connections (из UI LinkedIn)
     * @param {string} status — 'running'|'done'|'stopped'
     * @param {Array|null} contacts — передаём только при финальном сохранении
     */
    async function reportProgress(collected, total, status, contacts = null) {
      // Рассчитываем процент
      let percent;
      if (total && total > 0) {
        // Реальный прогресс через total
        percent = Math.min(99, Math.round((collected / total) * 100));
      } else {
        // Приблизительный: 5% → 95%, растёт логарифмически
        percent = collected > 0
          ? Math.min(95, Math.round(5 + Math.log(collected + 1) * 12))
          : 5;
      }
  
      if (status === 'done')    percent = 100;
      if (status === 'stopped') percent = Math.min(95, percent); // не ставим 100 если не закончили
  
      const payload = {
        crm_sync_percent: percent,
        crm_sync_count:   collected,
        crm_sync_total:   total,
        crm_sync_status:  status === 'running' ? 'running' : status,
        crm_sync_phase:   status === 'running' ? 'scrolling' : status
      };
  
      if (contacts !== null) payload.crm_contacts = contacts;
  
      await chrome.storage.local.set(payload);
    }
  
    // =====================================================================
    // HEARTBEAT
    // =====================================================================
  
    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        chrome.storage.local.set({ crm_heartbeat: Date.now() });
      }, CFG.heartbeatInterval);
    }
  
    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }
  
    // =====================================================================
    // ГЛАВНЫЙ ЦИКЛ — скролл + инкрементальный сбор
    // =====================================================================
  
    async function runSync(token) {
      console.log('[CRM] ══ Синхронизация запущена ══');
      startHeartbeat();
  
      // Загружаем ранее собранные контакты (дедупликация между сессиями)
      const stored   = await chrome.storage.local.get(['crm_contacts']);
      const existing = Array.isArray(stored.crm_contacts) ? stored.crm_contacts : [];
      existing.forEach(c => { if (c.profileUrl) seenUrls.add(c.profileUrl); });
  
      let allContacts = [...existing];
      let total       = null;
      let emptyCycles = 0;
  
      console.log(`[CRM] Загружено из storage: ${existing.length}`);
  
      // Ждём появления первых карточек (SPA грузит асинхронно)
      if (findProfileLinks().length === 0) {
        console.log('[CRM] Ждём первых карточек...');
        try {
          await waitForNewCards(0, 12000, token);
        } catch (e) {
          if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
        }
      }
  
      // Первый урожай до любого скролла
      const firstBatch = harvestNewContacts();
      allContacts.push(...firstBatch);
      total = getTotalConnections();
  
      await reportProgress(allContacts.length, total, 'running');
      console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total из UI: ${total}`);
  
      // ── Основной цикл ──
      while (true) {
        // Проверяем флаг отмены
        if (token.cancelled) {
          await onStopped(allContacts, total);
          return;
        }
  
        const countBefore   = findProfileLinks().length;
        const heightBefore  = document.body.scrollHeight;
        const atBottom      = window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
  
        // Скроллим на случайную величину
        const scrollPx = randomInt(CFG.scrollPxMin, CFG.scrollPxMax);
        performScroll(scrollPx);
  
        // Ждём новых карточек
        let appeared = false;
        try {
          const result = await waitForNewCards(countBefore, CFG.waitNewCardsMs, token);
          appeared = result === 'appeared';
        } catch (e) {
          if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
        }
  
        // Небольшая пауза чтобы LinkedIn дорендерил (React батчит обновления)
        try {
          const jitter = randomInt(0, CFG.pauseJitter);
          await delayOrCancel(CFG.pauseAfterScroll + jitter, token);
        } catch (e) {
          if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
        }
  
        // Собираем новые контакты
        const batch = harvestNewContacts();
        if (batch.length > 0) {
          allContacts.push(...batch);
          emptyCycles = 0;
          console.log(`[CRM] +${batch.length} контактов. Итого: ${allContacts.length}`);
  
          // Уточняем total (мог появиться после рендера)
          if (!total) total = getTotalConnections();
  
          // Сохраняем инкрементально — данные не теряются при стопе
          await reportProgress(allContacts.length, total, 'running', allContacts);
        } else {
          if (!appeared) {
            emptyCycles++;
            console.log(`[CRM] Нет новых карточек (${emptyCycles}/${CFG.maxEmptyCycles})`);
          }
        }
  
        // Определяем конец страницы — двойной критерий
        const heightAfter   = document.body.scrollHeight;
        const heightStopped = heightAfter === heightBefore;
        const reachedEnd    =
          (atBottom && emptyCycles >= CFG.maxEmptyCycles) ||
          (heightStopped && emptyCycles >= 2 && atBottom);
  
        if (reachedEnd) {
          console.log('[CRM] ✓ Достигнут конец страницы');
          break;
        }
      }
  
      // Финал — записываем с percent=100
      stopHeartbeat();
      isRunning = false;
  
      await chrome.storage.local.set({
        crm_contacts:      allContacts,
        crm_sync_count:    allContacts.length,
        crm_sync_total:    total,
        crm_sync_percent:  100,
        crm_sync_phase:    'done',
        crm_sync_status:   'done',
        crm_sync_command:  null
      });
  
      console.log(`[CRM] ✓ Синхронизация завершена. Всего: ${allContacts.length}`);
    }
  
    /** Вызывается при остановке (стоп или ошибка) — сохраняем что успели */
    async function onStopped(contacts, total) {
      stopHeartbeat();
      isRunning = false;
  
      const percent = total && total > 0
        ? Math.min(95, Math.round((contacts.length / total) * 100))
        : Math.min(95, contacts.length > 0 ? 5 + Math.round(Math.log(contacts.length + 1) * 12) : 0);
  
      await chrome.storage.local.set({
        crm_contacts:      contacts,
        crm_sync_count:    contacts.length,
        crm_sync_total:    total,
        crm_sync_percent:  percent,
        crm_sync_phase:    'stopped',
        crm_sync_status:   'stopped',
        crm_sync_command:  null
      });
  
      console.log(`[CRM] Остановлено. Сохранено: ${contacts.length}`);
    }
  
    // =====================================================================
    // ТОЧКА ВХОДА — запуск синхронизации
    // =====================================================================
  
    function startSync() {
      if (isRunning) {
        console.log('[CRM] Уже запущено, пропускаем');
        return;
      }
  
      isRunning    = true;
      currentToken = makeStopToken();
  
      // Сразу сигнализируем UI
      chrome.storage.local.set({
        crm_sync_status:  'running',
        crm_sync_phase:   'scrolling',
        crm_sync_percent: 1
      });
  
      runSync(currentToken).catch(err => {
        if (err instanceof CancelledError) return; // нормально
        console.error('[CRM] Критическая ошибка:', err);
        stopHeartbeat();
        isRunning = false;
        chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
      });
    }
  
    function stopSync() {
      if (!isRunning) return;
      console.log('[CRM] Команда STOP — отменяем токен');
      if (currentToken) currentToken.cancelled = true;
      // isRunning сбросится в onStopped()
    }
  
    // =====================================================================
    // КОМАНДЫ ЧЕРЕЗ chrome.storage.onChanged
    // =====================================================================
  
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.crm_sync_command) return;
      const cmd = changes.crm_sync_command.newValue;
      console.log('[CRM] storage command:', cmd);
  
      if (cmd === 'start') startSync();
      if (cmd === 'stop')  stopSync();
    });
  
    // =====================================================================
    // ОТВЕТ НА PING (background проверяет что скрипт жив)
    // =====================================================================
  
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'PING') {
        sendResponse({ alive: true, isRunning });
        return true;
      }
    });
  
    // =====================================================================
    // СТАРТ ПРИ ЗАГРУЗКЕ СТРАНИЦЫ
    // =====================================================================
  
    // Смотрим: есть ли активная команда start (восстановление / автозапуск)
    chrome.storage.local.get(['crm_sync_command'], data => {
      if (data.crm_sync_command === 'start') {
        console.log('[CRM] Автостарт при загрузке страницы');
        startSync();
      }
    });
  
    // Говорим background: скрипт загружен, готовы к командам
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  
    console.log('[CRM] content.js v0.6 готов');
  
  })();