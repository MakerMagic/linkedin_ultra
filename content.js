/**
 * content.js — LinkedIn CRM v1.1
 *
 * Изменения:
 *   1. findScrollContainer — ищет overflow:auto/scroll через getComputedStyle,
 *      поднимаясь вверх от реального DOM-элемента контакта.
 *      Это гарантирует скролл в фоновой вкладке.
 *   2. Паузы уменьшены в 2 раза (быстрее сбор).
 *   3. Всё остальное без изменений.
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const CFG = {
    scrollPxMin:        400,   // (было 300)
    scrollPxMax:        900,   // (было 700) — больший шаг, меньше итераций
    pauseAfterScroll:   700,   // (было 1500) — быстрее
    pauseJitter:        600,   // (было 1500) — быстрее
    waitNewCardsMs:     3000,  // (было 5000) — меньше ждём
    pollTotalMs:        500,
    confirmScrolls:     2,
    maxEmptyCyclesFB:   8,
    heartbeatInterval:  4000
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
      const id = setTimeout(() => {
        if (token.cancelled) reject(new CancelledError()); else resolve();
      }, ms);
      const check = setInterval(() => {
        if (token.cancelled) {
          clearTimeout(id); clearInterval(check);
          reject(new CancelledError());
        }
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
  let seenUrls       = new Set();

  // Кэшируем найденный контейнер — не ищем каждый раз
  let _cachedScrollContainer = null;

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
  // FIX 2: НАДЁЖНЫЙ ПОИСК СКРОЛЛ-КОНТЕЙНЕРА
  // =====================================================================

  /**
   * Стратегия поиска прокручиваемого контейнера:
   *
   * 1. Берём реальную карточку контакта из DOM (a[href*="/in/"])
   * 2. Поднимаемся по parentElement вверх
   * 3. Проверяем через getComputedStyle — ищем overflow-y: auto | scroll
   *    И scrollHeight > clientHeight + 100 (реально есть что скроллить)
   * 4. Fallback: document.body, потом document.documentElement
   *
   * Почему так:
   *   LinkedIn может переименовать классы, но overflow CSS — неизменяем.
   *   getComputedStyle работает в любой вкладке (активной и фоновой).
   *   element.scrollTop += N работает в фоновой вкладке — в отличие от
   *   window.scrollBy({ behavior: 'smooth' }).
   */
  function findScrollContainer() {
    // Используем кэш — не ищем каждую итерацию
    if (_cachedScrollContainer && document.contains(_cachedScrollContainer)) {
      return _cachedScrollContainer;
    }

    // Стартуем от первой карточки контакта
    const anchor = document.querySelector('a[href*="/in/"]');

    if (anchor) {
      let el = anchor.parentElement;
      let depth = 0;

      while (el && el !== document.documentElement && depth < 20) {
        const style    = window.getComputedStyle(el);
        const overflowY = style.overflowY;

        if (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 100
        ) {
          console.log(
            `[CRM] 📌 Контейнер скролла (depth=${depth}):`,
            el.tagName,
            el.id ? `#${el.id}` : '',
            el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''
          );
          _cachedScrollContainer = el;
          return el;
        }

        el = el.parentElement;
        depth++;
      }
    }

    // Fallback 1: document.body прокручивается?
    if (document.body.scrollHeight > document.body.clientHeight + 100) {
      const style = window.getComputedStyle(document.body);
      if (style.overflowY !== 'hidden') {
        console.log('[CRM] 📌 Контейнер скролла: document.body (fallback)');
        _cachedScrollContainer = document.body;
        return document.body;
      }
    }

    // Fallback 2: documentElement (html)
    console.log('[CRM] 📌 Контейнер скролла: document.documentElement (last resort)');
    _cachedScrollContainer = document.documentElement;
    return document.documentElement;
  }

  /**
   * Скроллит найденный контейнер вниз на px.
   *
   * element.scrollTop += N работает в фоновой (неактивной) вкладке.
   * window.scrollBy({ behavior: 'smooth' }) — не работает в фоне.
   */
  function performScroll(px) {
    const container = findScrollContainer();
    const before    = container.scrollTop;

    container.scrollTop += px;

    const after = container.scrollTop;

    // Если scrollTop не изменился — контейнер уже в конце или неверный
    // Сбрасываем кэш и пробуем ещё раз с другим контейнером
    if (after === before && before > 0) {
      console.log('[CRM] ⚠️ scrollTop не изменился — кэш сброшен');
      _cachedScrollContainer = null;
    }

    console.log(
      `[CRM] Скролл +${px}px | scrollTop: ${Math.round(before)}→${Math.round(after)}` +
      ` | bodyH=${document.body.scrollHeight}`
    );
  }

  // =====================================================================
  // ПАРСИНГ TOTAL ПО componentKey
  // =====================================================================

  function getTotalFromHeader() {
    const header = document.querySelector(
      '[componentKey="ConnectionsPage_ConnectionsListHeader"]'
    );

    if (header) {
      const p = header.querySelector('p');
      if (p) {
        const num = parseConnectionCount((p.textContent || '').trim());
        if (num) {
          console.log(`[CRM] ✅ Total (componentKey): ${num}`);
          return num;
        }
      }
      const num = parseConnectionCount((header.textContent || '').trim());
      if (num) {
        console.log(`[CRM] ✅ Total (header text): ${num}`);
        return num;
      }
    }

    // Fallback: h1 в main
    const h1 = document.querySelector('main h1');
    if (h1) {
      const num = parseConnectionCount(h1.textContent || '');
      if (num) {
        console.log(`[CRM] ✅ Total (main h1): ${num}`);
        return num;
      }
    }

    return null;
  }

  function parseConnectionCount(text) {
    if (!text || text.length > 100) return null;
    if (/mutual|shared|common|взаимн|общ(их|ий|ее)/i.test(text)) return null;
    const cleaned = text
      .replace(/connections?|connexions?|контакт[аов]*/gi, '')
      .replace(/\+/g, '')
      .trim();
    const m = cleaned.match(/(\d[\d,\s]*\d|\d)/);
    if (!m) return null;
    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    if (!num || num < 1 || num > 30000) return null;
    return num;
  }

  function pollForTotal(token) {
    return new Promise(resolve => {
      const immediate = getTotalFromHeader();
      if (immediate) { resolve(immediate); return; }
      const interval = setInterval(() => {
        if (token.cancelled) { clearInterval(interval); resolve(null); return; }
        const found = getTotalFromHeader();
        if (found) { clearInterval(interval); resolve(found); }
      }, CFG.pollTotalMs);
    });
  }

  // =====================================================================
  // ПОИСК ССЫЛОК И ИЗВЛЕЧЕНИЕ КОНТАКТОВ
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
  // ПРОГРЕСС
  // =====================================================================

  async function reportProgress(collected, total, phase, contacts = null) {
    let percent;

    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (phase === 'running') percent = Math.min(99, percent);
    } else {
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }

    if (phase === 'done')    percent = 100;
    if (phase === 'stopped') percent = total ? Math.min(95, percent) : Math.min(50, percent);

    // Строка без префикса — dashboard.html не добавляет свой префикс
    const label = total
      ? `Собрано ${collected} из ${total}`
      : `Собрано ${collected}`;

    const payload = {
      crm_sync_percent: percent,
      crm_sync_count:   collected,
      crm_sync_total:   total,
      crm_sync_label:   label,
      crm_sync_status:  phase === 'running' ? 'running' : phase,
      crm_sync_phase:   phase === 'running' ? 'scrolling' : phase
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
    console.log('[CRM] ══ Синхронизация v1.1 запущена ══');
    startHeartbeat();

    // Сбрасываем кэш контейнера — страница могла поменяться
    _cachedScrollContainer = null;

    let allContacts = [];
    let total       = null;
    let emptyCycles = 0;
    let confirmLeft = 0;

    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    // Первый урожай
    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    total = getTotalFromHeader();

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(не найден)'}`);

    // Логируем найденный контейнер сразу — до первого скролла
    findScrollContainer();

    await reportProgress(allContacts.length, total, 'running', allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) {
          total = found;
          console.log(`[CRM] Polling нашёл total: ${found}`);
        }
      });
    }

    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      if (total !== null && allContacts.length >= total) {
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++;
          console.log(`[CRM] Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
        } else {
          console.log(`[CRM] ✓ Завершено: ${allContacts.length} >= ${total}`);
          break;
        }
      } else if (total === null) {
        if (emptyCycles >= CFG.maxEmptyCyclesFB) {
          console.log(`[CRM] Fallback-стоп: ${emptyCycles} пустых скроллов`);
          break;
        }
      } else {
        confirmLeft = 0;
      }

      const countBefore = findProfileLinks().length;
      performScroll(randomInt(CFG.scrollPxMin, CFG.scrollPxMax));

      try {
        await waitForNewCards(countBefore, CFG.waitNewCardsMs, token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      try {
        await delayOrCancel(CFG.pauseAfterScroll + randomInt(0, CFG.pauseJitter), token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      if (!total) {
        const found = getTotalFromHeader();
        if (found) { total = found; console.log(`[CRM] Total в итерации: ${total}`); }
      }

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct})`);
        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
        await reportProgress(allContacts.length, total, 'running');
      }
    }

    stopHeartbeat();
    isRunning = false;

    await chrome.storage.local.set({
      crm_contacts:     allContacts,
      crm_sync_count:   allContacts.length,
      crm_sync_total:   total,
      crm_sync_percent: 100,
      crm_sync_label:   total ? `Собрано ${allContacts.length} из ${total}` : `Собрано ${allContacts.length}`,
      crm_sync_phase:   'done',
      crm_sync_status:  'done',
      crm_sync_command: null
    });

    console.log(`[CRM] ✓ Готово: ${allContacts.length}${total ? `/${total}` : ''}`);
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
      crm_sync_label:   total ? `Собрано ${contacts.length} из ${total}` : `Собрано ${contacts.length}`,
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
    seenUrls             = new Set();
    _cachedScrollContainer = null;
    isRunning            = true;
    currentToken         = makeStopToken();

    chrome.storage.local.set({
      crm_sync_status:  'running',
      crm_sync_phase:   'scrolling',
      crm_sync_percent: 1,
      crm_sync_count:   0,
      crm_sync_total:   null,
      crm_sync_label:   'Запуск…'
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
    if (currentToken) currentToken.cancelled = true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.crm_sync_command) return;
    const cmd = changes.crm_sync_command.newValue;
    if (cmd === 'start') startSync();
    if (cmd === 'stop')  stopSync();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ alive: true, isRunning }); return true; }
  });

  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') startSync();
  });

  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v1.1 готов');

})();