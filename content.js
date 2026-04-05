/**
 * content.js — LinkedIn CRM v0.8
 *
 * Исправлено:
 *   1. parseConnectionsText — исключает "mutual/shared/common connections"
 *      (было: total = 186 из "186 mutual connections" в карточках)
 *   2. getTotalConnectionsNow — ищет только в заголовочных зонах, НЕ в карточках
 *   3. waitForTotal — polling каждые 2 сек вместо одного MutationObserver
 *   4. sendMessage — проверка chrome.runtime?.id (убирает мусор в консоли)
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const CFG = {
    scrollPxMin:        300,
    scrollPxMax:        700,
    pauseAfterScroll:   1500,
    pauseJitter:        1500,
    waitNewCardsMs:     5000,
    confirmScrolls:     2,       // доп. скроллов после collected>=total
    maxEmptyCyclesFB:   8,       // fallback-стоп когда total не найден
    heartbeatInterval:  4000,
    totalPollInterval:  2000,    // мс — как часто повторяем поиск total
    totalPollTimeout:   20000    // мс — максимум ждём total
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
  // ПАРСИНГ TOTAL CONNECTIONS — ИСПРАВЛЕННАЯ ВЕРСИЯ
  // =====================================================================

  /**
   * ✅ ИСПРАВЛЕНО: исключаем "mutual/shared/common connections".
   *
   * LinkedIn показывает на карточках:
   *   "186 mutual connections" — НЕ наш total, это общие знакомые
   *   "34 shared connections"  — тоже не наш total
   *
   * Нам нужно:
   *   "1,234 connections"      — общий счётчик в заголовке страницы
   *   "500+ connections"
   */
  function parseConnectionsText(text) {
    if (!text) return null;

    // ❌ Исключаем "mutual", "shared", "common", "взаимн" перед/после числа
    // Это "186 mutual connections" из карточек контактов — не наш total
    if (/mutual|shared|common|взаимн|в общем/i.test(text)) return null;

    // ❌ Исключаем длинные предложения (заголовок страницы — короткий текст)
    if (text.length > 80) return null;

    const m = text.match(/([\d][0-9,\s]*)\+?\s*(?:connections?|connexions?|контакт)/i);
    if (!m) return null;

    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);

    // Санитарная проверка: разумный диапазон (1 — 30 000)
    if (num < 1 || num > 30000) return null;

    return num;
  }

  /**
   * ✅ ИСПРАВЛЕНО: ищем total ТОЛЬКО в заголовочных зонах страницы.
   *
   * Было: сканировали весь DOM включая карточки контактов
   * → находили "186 mutual connections" и останавливались на 186
   *
   * Теперь: только предсказуемые места где LinkedIn показывает ОБЩИЙ счётчик
   */
  function getTotalConnectionsNow() {

    // ── Приоритетные селекторы (конкретные места заголовка) ──
    const headerSelectors = [
      '.mn-connections__header',                        // старый UI
      '[data-view-name="connections-list-header"]',     // новый UI
      'header h1',
      'main > div > h1',                                // прямой потомок main
      '.artdeco-card h1',
      '.scaffold-layout__main h1',
    ];

    for (const sel of headerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const num = parseConnectionsText(el.textContent);
        if (num) {
          console.log(`[CRM] ✅ Total найден (${sel}): ${num}`);
          return num;
        }
      }
    }

    // ── Умеренный поиск: только верхняя часть страницы ──
    // Берём первые 20 h1/h2/h3 и span с числами — они точно выше карточек
    const topEls = Array.from(
      document.querySelectorAll('h1, h2, h3, [class*="header"] span, [class*="title"] span')
    ).slice(0, 20);

    for (const el of topEls) {
      // Только прямой текст узла — не дочерние (избегаем вложенных карточек)
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent)
        .join(' ');

      const num = parseConnectionsText(direct);
      if (num) {
        console.log(`[CRM] ✅ Total найден (умеренный поиск): ${num} — "${direct.trim().slice(0, 60)}"`);
        return num;
      }
    }

    return null;
  }

  /**
   * ✅ ИСПРАВЛЕНО: polling каждые 2 сек вместо одного MutationObserver.
   *
   * MutationObserver мог пропустить момент рендера если LinkedIn делал
   * batch-обновление без добавления новых узлов (только изменение текста).
   * Polling гарантирует что мы проверим в нужный момент.
   */
  function waitForTotal(timeoutMs) {
    return new Promise(resolve => {
      // Проверяем сразу
      const immediate = getTotalConnectionsNow();
      if (immediate) { resolve(immediate); return; }

      let settled = false;
      const finish = val => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(giveUpTimer);
        resolve(val);
      };

      // Polling каждые 2 сек
      const pollTimer = setInterval(() => {
        const val = getTotalConnectionsNow();
        if (val) finish(val);
      }, CFG.totalPollInterval);

      // Даём максимум timeoutMs
      const giveUpTimer = setTimeout(() => {
        console.warn(`[CRM] ⚠️ Total не найден за ${timeoutMs}мс — работаем без него`);
        finish(null);
      }, timeoutMs);
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

    const stored   = await chrome.storage.local.get(['crm_contacts']);
    const existing = Array.isArray(stored.crm_contacts) ? stored.crm_contacts : [];
    existing.forEach(c => { if (c.profileUrl) seenUrls.add(c.profileUrl); });

    let allContacts = [...existing];
    let emptyCycles = 0;
    let confirmLeft = 0;

    await reportProgress(allContacts.length, null, 'running');

    // Ждём первых карточек
    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 12000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    // Ищем total (polling, до 20 сек)
    console.log('[CRM] Ищем total connections...');
    let total = await waitForTotal(CFG.totalPollTimeout);
    console.log(`[CRM] Total: ${total ?? '⚠️ не найден — fallback-режим'}`);

    // Первый урожай
    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total}`);
    await reportProgress(allContacts.length, total, 'running', allContacts);

    // ── Основной цикл ──
    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // Условие остановки
      if (total !== null) {
        if (allContacts.length >= total) {
          if (confirmLeft < CFG.confirmScrolls) {
            confirmLeft++;
            console.log(`[CRM] Достигнут total=${total}. Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
          } else {
            console.log(`[CRM] ✓ Завершено: ${allContacts.length} >= ${total}`);
            break;
          }
        } else {
          confirmLeft = 0;
        }
      } else {
        if (emptyCycles >= CFG.maxEmptyCyclesFB) {
          console.log(`[CRM] Fallback-стоп: ${emptyCycles} пустых скроллов`);
          break;
        }
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

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total} (${Math.round(allContacts.length/total*100)}%)` : ''}`);

        // Пробуем уточнить total если ещё не нашли
        if (!total) {
          total = getTotalConnectionsNow();
          if (total) console.log(`[CRM] Total уточнён: ${total}`);
        }

        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (пустых: ${emptyCycles})`);
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

  // Автостарт при загрузке
  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') {
      console.log('[CRM] Автостарт при загрузке');
      startSync();
    }
  });

  // ✅ ИСПРАВЛЕНО: проверяем chrome.runtime?.id перед отправкой
  // Убирает "Could not establish connection" когда SW засыпает
  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v0.8 готов');

})();