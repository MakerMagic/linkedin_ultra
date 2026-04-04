/**
 * content.js — LinkedIn CRM v0.7
 *
 * Исправлено:
 *   1. Остановка скролла ТОЛЬКО когда collected >= total (не по emptyCycles)
 *   2. getTotalConnections — polling до 15 сек, расширенный поиск по DOM
 *   3. После достижения total — 2 контрольных скролла (не пропускаем хвост)
 *   4. emptyCycles — только аварийный fallback когда total вообще не найден
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const CFG = {
    scrollPxMin:        300,   // px — минимальный шаг скролла
    scrollPxMax:        700,   // px — максимальный шаг скролла
    pauseAfterScroll:   1500,  // мс — базовая пауза после скролла
    pauseJitter:        1500,  // мс — случайная добавка (итого 1.5–3 сек)
    waitNewCardsMs:     5000,  // мс — ждём новые карточки после скролла
    confirmScrolls:     2,     // доп. скроллов после collected>=total (подбираем хвост)
    // Аварийный fallback (только если total не найден):
    maxEmptyCyclesFB:   8,     // N скроллов подряд без новых → принудительный стоп
    heartbeatInterval:  4000   // мс — маяк жизни
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
      const id    = setTimeout(() => { if (token.cancelled) reject(new CancelledError()); else resolve(); }, ms);
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
  const seenUrls     = new Set();

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
   * Ищет число вида "1,234" или "500+" перед словом connections/connexions/контакт.
   * Возвращает число или null.
   */
  function parseConnectionsText(text) {
    if (!text) return null;
    // Паттерны: "1,234 connections", "500+ connections", "1 234 connections" (ru пробел)
    const m = text.match(/([\d][0-9,\s]*)\+?\s*(?:connections?|connexions?|контакт)/i);
    if (!m) return null;
    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    return num > 0 ? num : null;
  }

  /**
   * Синхронная попытка найти total в текущем DOM.
   * Перебирает расширенный список мест где LinkedIn может показывать счётчик.
   */
  function getTotalConnectionsNow() {
    // Набор конкретных селекторов LinkedIn (порядок по надёжности)
    const specificSelectors = [
      // Новый UI (2024+): заголовок в aside панели
      '.mn-connections__header',
      '[data-view-name="connections-list-header"]',
      // Старый UI: h1 в основном контенте
      'main h1',
      // Счётчик в profile-навигации иногда
      '.t-18.t-black.t-bold',
      // Fallback: любой h1/h2
      'h1', 'h2',
    ];

    for (const sel of specificSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const num = parseConnectionsText(el.textContent);
        if (num) {
          console.log(`[CRM] Total найден (${sel}): ${num} — "${el.textContent.trim().slice(0, 80)}"`);
          return num;
        }
      }
    }

    // Широкий поиск: любой элемент на странице с числом перед "connections"
    const allEls = document.querySelectorAll(
      'span, p, h1, h2, h3, h4, div, li, a, button, strong, b'
    );
    for (const el of allEls) {
      // Проверяем только прямой текст узла (не дочерние) — быстрее и точнее
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent)
        .join(' ');
      const num = parseConnectionsText(direct);
      if (num) {
        console.log(`[CRM] Total найден (широкий поиск): ${num} — "${direct.trim().slice(0, 80)}"`);
        return num;
      }
    }

    return null;
  }

  /**
   * Ждёт появления total в DOM до timeoutMs мс.
   * LinkedIn рендерит счётчик асинхронно — нужно подождать.
   * @returns {Promise<number|null>}
   */
  function waitForTotal(timeoutMs) {
    return new Promise(resolve => {
      // Сразу проверяем
      const now = getTotalConnectionsNow();
      if (now) { resolve(now); return; }

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        obs.disconnect();
        resolve(val);
      };

      const timer = setTimeout(() => {
        console.warn('[CRM] Total не найден за', timeoutMs, 'мс — работаем без него');
        finish(null);
      }, timeoutMs);

      // Следим за DOM — как только появится нужный текст, парсим
      const obs = new MutationObserver(() => {
        const val = getTotalConnectionsNow();
        if (val) finish(val);
      });

      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
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
  // СКРОЛЛ
  // =====================================================================

  function performScroll(px) {
    // Пробуем скроллить контейнер списка (некоторые версии LinkedIn)
    const container =
      document.querySelector('.scaffold-finite-scroll__content') ||
      document.querySelector('.mn-connections__list') ||
      document.querySelector('[data-view-name="connections-list"]') ||
      document.querySelector('main');

    if (container && container.scrollHeight > container.clientHeight) {
      container.scrollTop += px;
    }

    // Основной вариант — window (instant работает на фоновой вкладке)
    window.scrollBy({ top: px, behavior: 'instant' });

    console.log(`[CRM] Скролл +${px}px | scrollY=${Math.round(window.scrollY)} | bodyH=${document.body.scrollHeight}`);
  }

  // =====================================================================
  // ПРОГРЕСС В STORAGE
  // =====================================================================

  async function reportProgress(collected, total, status, contacts = null) {
    let percent;

    if (total && total > 0) {
      // ✅ Реальный прогресс: собрано / total
      percent = Math.round((collected / total) * 100);
      // Ограничиваем: 99% до финала, 100% только при status=done
      if (status !== 'done') percent = Math.min(99, percent);
    } else {
      // Fallback когда total неизвестен — логарифмический рост
      percent = collected > 0
        ? Math.min(95, Math.round(5 + Math.log(collected + 1) * 12))
        : 2;
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

    // Загружаем ранее собранные (дедупликация между сессиями)
    const stored   = await chrome.storage.local.get(['crm_contacts']);
    const existing = Array.isArray(stored.crm_contacts) ? stored.crm_contacts : [];
    existing.forEach(c => { if (c.profileUrl) seenUrls.add(c.profileUrl); });

    let allContacts = [...existing];
    let emptyCycles = 0;       // только для fallback-остановки (когда total=null)
    let confirmLeft = 0;       // доп. скроллы после достижения total

    await reportProgress(allContacts.length, null, 'running');

    // ── Ждём первых карточек ──
    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 12000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    // ── Ищем total в DOM (ждём до 15 сек — LinkedIn грузит асинхронно) ──
    console.log('[CRM] Ищем total connections в DOM...');
    let total = await waitForTotal(15000);
    console.log(`[CRM] Total: ${total ?? 'не найден — работаем без него'}`);

    // Первый урожай до скролла
    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Ранее: ${existing.length}. Total: ${total}`);

    await reportProgress(allContacts.length, total, 'running', allContacts);

    // ── Основной цикл ──
    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // ── Условие остановки ──

      if (total !== null) {
        // ГЛАВНОЕ условие: собрано >= total
        if (allContacts.length >= total) {
          if (confirmLeft < CFG.confirmScrolls) {
            // Делаем confirmScrolls доп. скроллов — подбираем хвост
            confirmLeft++;
            console.log(`[CRM] Достигнут total=${total}. Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
          } else {
            console.log(`[CRM] ✓ Завершено: собрано ${allContacts.length} >= total ${total}`);
            break;
          }
        } else {
          confirmLeft = 0; // Если появились новые — сбрасываем счётчик подтверждений
        }
      } else {
        // Fallback (total неизвестен): остановка по emptyCycles
        if (emptyCycles >= CFG.maxEmptyCyclesFB) {
          console.log(`[CRM] Fallback-стоп: ${emptyCycles} скроллов без новых карточек`);
          break;
        }
      }

      const countBefore = findProfileLinks().length;
      const scrollPx    = randomInt(CFG.scrollPxMin, CFG.scrollPxMax);
      performScroll(scrollPx);

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

      // Собираем новые контакты
      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        console.log(`[CRM] +${batch.length} | Итого: ${allContacts.length}${total ? ` / ${total}` : ''} | ${total ? Math.round(allContacts.length/total*100) : '?'}%`);

        // Уточняем total если ещё не нашли
        if (!total) {
          total = getTotalConnectionsNow();
          if (total) console.log(`[CRM] Total уточнён: ${total}`);
        }

        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых карточек (пустых: ${emptyCycles})`);

        // Даже без новых — обновляем прогресс чтобы dashboard не думал что завис
        await reportProgress(allContacts.length, total, 'running');
      }
    }

    // ── Финал ──
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

    console.log(`[CRM] ✓ Готово. Собрано: ${allContacts.length}${total ? ` / ${total}` : ''}`);
  }

  async function onStopped(contacts, total) {
    stopHeartbeat();
    isRunning = false;

    const percent = (total && total > 0)
      ? Math.min(95, Math.round((contacts.length / total) * 100))
      : Math.min(95, contacts.length > 0 ? 5 + Math.round(Math.log(contacts.length + 1) * 12) : 0);

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

    isRunning    = true;
    currentToken = makeStopToken();

    chrome.storage.local.set({ crm_sync_status: 'running', crm_sync_phase: 'scrolling', crm_sync_percent: 1 });

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

  // Автостарт при загрузке (восстановление после перезагрузки вкладки)
  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') {
      console.log('[CRM] Автостарт при загрузке');
      startSync();
    }
  });

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  console.log('[CRM] content.js v0.7 готов');

})();