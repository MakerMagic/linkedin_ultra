/**
 * content.js — LinkedIn CRM v0.9
 *
 * Исправлено:
 *   1. seenUrls очищается при каждом startSync() — был главный баг
 *      (190 URL оставались в Set → новые контакты не добавлялись)
 *   2. crm_sync_count сбрасывается в 0 при старте — убирает "190 сразу"
 *   3. total ищем в каждой итерации цикла — не блокируем старт его ожиданием
 *   4. allContacts начинается с нуля — чистая новая сессия
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const CFG = {
    scrollPxMin:       300,
    scrollPxMax:       700,
    pauseAfterScroll:  1500,  // мс — базовая пауза
    pauseJitter:       1500,  // мс — случайная добавка (итого 1.5–3 сек)
    waitNewCardsMs:    5000,  // мс — ждём новые карточки через MutationObserver
    confirmScrolls:    2,     // доп. скроллов после collected >= total
    maxEmptyCyclesFB:  8,     // fallback-стоп когда total не найден
    heartbeatInterval: 4000   // мс — маяк жизни для dashboard
  };

  // =====================================================================
  // STOP TOKEN
  // =====================================================================

  class CancelledError extends Error {
    constructor() { super('cancelled'); this.name = 'CancelledError'; }
  }

  function makeStopToken() { return { cancelled: false }; }

  function delayOrCancel(ms, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      const id    = setTimeout(() => {
        if (token.cancelled) reject(new CancelledError()); else resolve();
      }, ms);
      const check = setInterval(() => {
        if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  // =====================================================================
  // ГЛОБАЛЬНОЕ СОСТОЯНИЕ
  // =====================================================================

  let isRunning      = false;
  let currentToken   = null;
  let heartbeatTimer = null;

  /**
   * ✅ ИСПРАВЛЕНО: seenUrls теперь НЕ module-level константа.
   * Пересоздаётся в startSync() → каждый запуск начинается чисто.
   *
   * Было: const seenUrls = new Set()  — сохранялся между запусками
   * Стало: let seenUrls — сбрасывается в startSync()
   */
  let seenUrls = new Set();

  // =====================================================================
  // УТИЛИТЫ
  // =====================================================================

  function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function normalizeProfileUrl(href) {
    if (!href) return null;
    try {
      const base = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
      const m    = new URL(base).pathname.match(/^\/in\/([^/?#]+)/);
      return m ? 'https://www.linkedin.com/in/' + m[1] : null;
    } catch { return null; }
  }

  function nameFromAriaLabel(label) {
    if (!label) return null;
    let m = label.match(/^view\s+(.+?)(?:'s)?\s+profile$/i);
    if (m) return m[1].trim();
    m = label.match(/просмотреть профиль[:\s]+(.+)/i);
    if (m) return m[1].trim();
    return null;
  }

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]')
      .forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // =====================================================================
  // ПАРСИНГ TOTAL CONNECTIONS
  // =====================================================================

  /**
   * Парсит число из текста вида "1,234 connections" или "500+ connections".
   *
   * Исключаем "mutual/shared/common connections" — это общие знакомые
   * из карточек контактов, не общий счётчик страницы.
   */
  function parseConnectionsText(text) {
    if (!text) return null;

    // Исключаем "mutual/shared/common connections" из карточек
    if (/mutual|shared|common|взаимн|в общем/i.test(text)) return null;

    // Заголовок страницы — короткий текст
    if (text.length > 80) return null;

    const m = text.match(/([\d][0-9,\s]*)\+?\s*(?:connections?|connexions?|контакт)/i);
    if (!m) return null;

    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    if (num < 1 || num > 30000) return null;

    return num;
  }

  /**
   * Синхронный поиск total в DOM — только в безопасных заголовочных зонах.
   *
   * НЕ сканируем весь DOM — иначе находим "186 mutual connections"
   * из карточек и останавливаемся на 186.
   */
  function getTotalConnectionsNow() {
    // Приоритетные места где LinkedIn показывает ОБЩИЙ счётчик
    const headerSelectors = [
      '.mn-connections__header',
      '[data-view-name="connections-list-header"]',
      'header h1',
      'main > div > h1',
      '.artdeco-card h1',
      '.scaffold-layout__main h1',
    ];

    for (const sel of headerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const num = parseConnectionsText(el.textContent);
        if (num) {
          console.log(`[CRM] ✅ Total (${sel}): ${num}`);
          return num;
        }
      }
    }

    // Умеренный поиск: первые 15 заголовочных элементов
    const topEls = Array.from(
      document.querySelectorAll('h1, h2, h3, [class*="header"] span, [class*="title"] span')
    ).slice(0, 15);

    for (const el of topEls) {
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent)
        .join(' ');
      const num = parseConnectionsText(direct);
      if (num) {
        console.log(`[CRM] ✅ Total (умеренный поиск): ${num}`);
        return num;
      }
    }

    return null;
  }

  // =====================================================================
  // ПОИСК ССЫЛОК НА ПРОФИЛИ
  // =====================================================================

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
  // ИЗВЛЕЧЕНИЕ КОНТАКТА
  // =====================================================================

  function extractContact(link) {
    const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
    if (!profileUrl) return null;

    let fullName = null;

    fullName = nameFromAriaLabel(link.getAttribute('aria-label'));

    if (!fullName) {
      const el = link.querySelector('[class*="name"], [class*="title-text"], [class*="person-name"]');
      if (el) fullName = cleanText(el);
    }

    if (!fullName) {
      const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
      if (card) {
        const el = card.querySelector('[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title');
        if (el) fullName = cleanText(el);
      }
    }

    if (!fullName) {
      const card = link.closest('li, [class*="card"]');
      if (card) {
        const img = card.querySelector('img[alt]:not([alt=""])');
        if (img) fullName = (img.getAttribute('alt') || '').trim();
      }
    }

    if (!fullName) fullName = cleanText(link);

    if (!fullName || fullName.length < 2) return null;
    if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more|open)$/i.test(fullName)) return null;

    return { profileUrl, fullName };
  }

  // =====================================================================
  // ИНКРЕМЕНТАЛЬНЫЙ СБОР
  // =====================================================================

  /**
   * Берёт ВСЕ текущие ссылки в DOM, добавляет только новые через seenUrls.
   * Вызывается после каждого скролла.
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
  // ОЖИДАНИЕ НОВЫХ КАРТОЧЕК
  // =====================================================================

  function waitForNewCards(currentCount, timeoutMs, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      if (findProfileLinks().length > currentCount) { resolve('appeared'); return; }

      let done = false;
      const finish = reason => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(cancelCheck);
        obs.disconnect();
        if (token.cancelled) reject(new CancelledError());
        else resolve(reason);
      };

      const timer       = setTimeout(() => finish('timeout'), timeoutMs);
      const cancelCheck = setInterval(() => { if (token.cancelled) finish('cancelled'); }, 100);
      const obs         = new MutationObserver(() => {
        if (findProfileLinks().length > currentCount) finish('appeared');
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // =====================================================================
  // СКРОЛЛ (работает на фоновой вкладке — behavior: instant)
  // =====================================================================

  function performScroll(px) {
    const container =
      document.querySelector('.scaffold-finite-scroll__content') ||
      document.querySelector('.mn-connections__list') ||
      document.querySelector('[data-view-name="connections-list"]') ||
      document.querySelector('main');

    if (container && container.scrollHeight > container.clientHeight) {
      container.scrollTop += px;
    }

    window.scrollBy({ top: px, behavior: 'instant' });

    console.log(`[CRM] Скролл +${px}px | scrollY=${Math.round(window.scrollY)} | bodyH=${document.body.scrollHeight}`);
  }

  // =====================================================================
  // ПРОГРЕСС В STORAGE
  // =====================================================================

  async function reportProgress(collected, total, status, contacts = null) {
    let percent;

    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (status !== 'done') percent = Math.min(99, percent);
    } else {
      // Если total неизвестен — не показываем фиктивный %, держим маленькое значение
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }

    if (status === 'done')    percent = 100;
    if (status === 'stopped') percent = Math.min(95, percent);

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
    heartbeatTimer = setInterval(
      () => chrome.storage.local.set({ crm_heartbeat: Date.now() }),
      CFG.heartbeatInterval
    );
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // =====================================================================
  // ГЛАВНЫЙ ЦИКЛ
  // =====================================================================

  async function runSync(token) {
    console.log('[CRM] ══ Синхронизация запущена ══');
    startHeartbeat();

    // ✅ ИСПРАВЛЕНО: allContacts всегда начинается с нуля — новая сессия
    // Не грузим existing — счётчик должен начать с 0
    let allContacts = [];
    let total       = null;
    let emptyCycles = 0;
    let confirmLeft = 0;

    // Ждём первых карточек (SPA грузит асинхронно)
    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    // Первый урожай + первая попытка найти total
    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    total = getTotalConnectionsNow();

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(ещё не найден)'}`);
    await reportProgress(allContacts.length, total, 'running', allContacts);

    // ── Основной цикл: скролл + сбор + поиск total ──
    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // ── Условие остановки ──
      if (total !== null && allContacts.length >= total) {
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++;
          console.log(`[CRM] Достигнут total=${total}. Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
        } else {
          console.log(`[CRM] ✓ Завершено: ${allContacts.length} >= ${total}`);
          break;
        }
      } else if (total === null) {
        // Fallback: total ещё не найден — останавливаемся по emptyCycles
        if (emptyCycles >= CFG.maxEmptyCyclesFB) {
          console.log(`[CRM] Fallback-стоп: ${emptyCycles} пустых скроллов`);
          break;
        }
      } else {
        // total известен, но ещё не набрали — сбрасываем confirmLeft
        confirmLeft = 0;
      }

      // Скролл
      const countBefore = findProfileLinks().length;
      performScroll(randomInt(CFG.scrollPxMin, CFG.scrollPxMax));

      // Ждём новых карточек
      try {
        await waitForNewCards(countBefore, CFG.waitNewCardsMs, token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      // Пауза (имитация человека)
      try {
        await delayOrCancel(CFG.pauseAfterScroll + randomInt(0, CFG.pauseJitter), token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      // ✅ ИСПРАВЛЕНО: total ищем в КАЖДОЙ итерации — не блокируем старт
      // LinkedIn может отрендерить счётчик в любой момент после загрузки карточек
      if (!total) {
        total = getTotalConnectionsNow();
        if (total) console.log(`[CRM] ✅ Total найден в итерации: ${total}`);
      }

      // Собираем новые контакты
      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        const pct = total ? `${Math.round(allContacts.length/total*100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct})`);

        // Сохраняем контакты после каждого батча — данные не теряются при стопе
        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (пустых: ${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
        await reportProgress(allContacts.length, total, 'running');
      }
    }

    // Финал
    stopHeartbeat();
    isRunning = false;

    await chrome.storage.local.set({
      crm_contacts:     allContacts,
      crm_sync_count:   allContacts.length,
      crm_sync_total:   total,
      crm_sync_percent: 100,
      crm_sync_phase:   'done',
      crm_sync_status:  'done',
      crm_sync_command: null
    });

    console.log(`[CRM] ✓ Готово. Собрано: ${allContacts.length}${total ? `/${total}` : ''}`);
  }

  async function onStopped(contacts, total) {
    stopHeartbeat();
    isRunning = false;

    const percent = (total && total > 0)
      ? Math.min(95, Math.round((contacts.length / total) * 100))
      : Math.min(15, contacts.length > 0 ? Math.round(contacts.length / 10) : 0);

    await chrome.storage.local.set({
      crm_contacts:     contacts,
      crm_sync_count:   contacts.length,
      crm_sync_total:   total,
      crm_sync_percent: percent,
      crm_sync_phase:   'stopped',
      crm_sync_status:  'stopped',
      crm_sync_command: null
    });

    console.log(`[CRM] Остановлено. Сохранено: ${contacts.length}`);
  }

  // =====================================================================
  // ТОЧКА ВХОДА
  // =====================================================================

  function startSync() {
    if (isRunning) { console.log('[CRM] Уже запущено'); return; }

    // ✅ ИСПРАВЛЕНО: очищаем seenUrls при каждом новом запуске
    // Было: Set оставался с предыдущей сессии → новые контакты не добавлялись
    seenUrls = new Set();

    isRunning    = true;
    currentToken = makeStopToken();

    // ✅ ИСПРАВЛЕНО: сразу сбрасываем счётчик в 0 — не показываем старые данные
    chrome.storage.local.set({
      crm_sync_status:  'running',
      crm_sync_phase:   'scrolling',
      crm_sync_percent: 1,
      crm_sync_count:   0,      // ← сброс счётчика
      crm_sync_total:   null    // ← сброс total до нахождения
    });

    runSync(currentToken).catch(err => {
      if (err instanceof CancelledError) return;
      console.error('[CRM] Критическая ошибка:', err);
      stopHeartbeat();
      isRunning = false;
      chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
    });
  }

  function stopSync() {
    if (!isRunning) return;
    console.log('[CRM] STOP → отменяем токен');
    if (currentToken) currentToken.cancelled = true;
  }

  // =====================================================================
  // КОМАНДЫ
  // =====================================================================

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.crm_sync_command) return;
    const cmd = changes.crm_sync_command.newValue;
    if (cmd === 'start') startSync();
    if (cmd === 'stop')  stopSync();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ alive: true, isRunning }); return true; }
  });

  // Автостарт при загрузке страницы (восстановление / команда из background)
  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') {
      console.log('[CRM] Автостарт при загрузке');
      startSync();
    }
  });

  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v0.9 готов');

})();