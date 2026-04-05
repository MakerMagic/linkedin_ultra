/**
 * content.js — LinkedIn CRM v1.2
 *
 * Новое:
 *   ETA (примерное время до конца) — скользящее среднее по последним 6 батчам.
 *   Пишем crm_sync_eta_seconds в storage — dashboard читает и отображает.
 *
 * Остальное без изменений относительно v1.1.
 */
(function () {
  'use strict';

  const CFG = {
    scrollPxMin:        400,
    scrollPxMax:        900,
    pauseAfterScroll:   700,
    pauseJitter:        600,
    waitNewCardsMs:     3000,
    pollTotalMs:        500,
    confirmScrolls:     2,
    maxEmptyCyclesFB:   8,
    heartbeatInterval:  4000,
    etaWindowSize:      6    // сколько последних батчей используем для расчёта скорости
  };

  // ── Stop Token ────────────────────────────────────────────────────────────

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
        if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  // ── Состояние ─────────────────────────────────────────────────────────────

  let isRunning      = false;
  let currentToken   = null;
  let heartbeatTimer = null;
  let seenUrls       = new Set();
  let _cachedScrollContainer = null;

  // ── Утилиты ───────────────────────────────────────────────────────────────

  function randomInt(min, max) { return Math.floor(min + Math.random() * (max - min)); }

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
    clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── Скролл контейнера ─────────────────────────────────────────────────────

  function findScrollContainer() {
    if (_cachedScrollContainer && document.contains(_cachedScrollContainer)) return _cachedScrollContainer;

    const anchor = document.querySelector('a[href*="/in/"]');
    if (anchor) {
      let el = anchor.parentElement;
      let depth = 0;
      while (el && el !== document.documentElement && depth < 20) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
          console.log(`[CRM] 📌 Контейнер (depth=${depth}):`, el.tagName, el.className.trim().split(/\s+/)[0] || '');
          _cachedScrollContainer = el;
          return el;
        }
        el = el.parentElement;
        depth++;
      }
    }

    if (document.body.scrollHeight > document.body.clientHeight + 100) {
      const ov = window.getComputedStyle(document.body).overflowY;
      if (ov !== 'hidden') { _cachedScrollContainer = document.body; return document.body; }
    }

    _cachedScrollContainer = document.documentElement;
    return document.documentElement;
  }

  function performScroll(px) {
    const container = findScrollContainer();
    const before    = container.scrollTop;
    container.scrollTop += px;
    const after = container.scrollTop;
    if (after === before && before > 0) { _cachedScrollContainer = null; }
    console.log(`[CRM] Скролл +${px}px | scrollTop: ${Math.round(before)}→${Math.round(after)}`);
  }

  // ── Total ─────────────────────────────────────────────────────────────────

  function getTotalFromHeader() {
    const header = document.querySelector('[componentKey="ConnectionsPage_ConnectionsListHeader"]');
    if (header) {
      const p   = header.querySelector('p');
      const num = parseConnectionCount((p?.textContent || header.textContent || '').trim());
      if (num) { console.log(`[CRM] ✅ Total: ${num}`); return num; }
    }
    const h1 = document.querySelector('main h1');
    if (h1) {
      const num = parseConnectionCount(h1.textContent || '');
      if (num) { console.log(`[CRM] ✅ Total (h1): ${num}`); return num; }
    }
    return null;
  }

  function parseConnectionCount(text) {
    if (!text || text.length > 100) return null;
    if (/mutual|shared|common|взаимн|общ(их|ий|ее)/i.test(text)) return null;
    const cleaned = text.replace(/connections?|connexions?|контакт[аов]*/gi, '').replace(/\+/g, '').trim();
    const m = cleaned.match(/(\d[\d,\s]*\d|\d)/);
    if (!m) return null;
    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    return (num && num >= 1 && num <= 30000) ? num : null;
  }

  function pollForTotal(token) {
    return new Promise(resolve => {
      const imm = getTotalFromHeader();
      if (imm) { resolve(imm); return; }
      const iv = setInterval(() => {
        if (token.cancelled) { clearInterval(iv); resolve(null); return; }
        const f = getTotalFromHeader();
        if (f) { clearInterval(iv); resolve(f); }
      }, CFG.pollTotalMs);
    });
  }

  // ── DOM: ссылки и извлечение ──────────────────────────────────────────────

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

    let fullName = nameFromAriaLabel(link.getAttribute('aria-label'));

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

  // ── MutationObserver ──────────────────────────────────────────────────────

  function waitForNewCards(currentCount, timeoutMs, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      if (findProfileLinks().length > currentCount) { resolve('appeared'); return; }
      let done = false;
      const finish = reason => {
        if (done) return; done = true;
        clearTimeout(timer); clearInterval(cancelCheck); obs.disconnect();
        token.cancelled ? reject(new CancelledError()) : resolve(reason);
      };
      const timer       = setTimeout(() => finish('timeout'), timeoutMs);
      const cancelCheck = setInterval(() => { if (token.cancelled) finish('cancelled'); }, 100);
      const obs         = new MutationObserver(() => { if (findProfileLinks().length > currentCount) finish('appeared'); });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ── ETA (новое) ───────────────────────────────────────────────────────────

  /**
   * Хранит последние CFG.etaWindowSize точек {ts, count}.
   * После каждого батча добавляем точку и считаем скорость (контактов/сек).
   * ETA = (total - collected) / скорость
   */
  const timingWindow = [];

  function pushTiming(count) {
    timingWindow.push({ ts: Date.now(), count });
    if (timingWindow.length > CFG.etaWindowSize) timingWindow.shift();
  }

  /**
   * Возвращает ETA в секундах или null если данных недостаточно.
   * Использует линейную регрессию по окну — устойчивее к выбросам.
   */
  function calcEtaSeconds(collected, total) {
    if (!total || total <= collected) return null;
    if (timingWindow.length < 2) return null;

    const first = timingWindow[0];
    const last  = timingWindow[timingWindow.length - 1];
    const dCount = last.count - first.count;
    const dTime  = (last.ts - first.ts) / 1000; // секунды

    if (dCount <= 0 || dTime <= 0) return null;

    const ratePerSec = dCount / dTime;                     // контакт/сек
    const remaining  = total - collected;
    return Math.max(0, Math.round(remaining / ratePerSec));
  }

  // ── Progress ──────────────────────────────────────────────────────────────

  async function reportProgress(collected, total, phase, etaSeconds = null, contacts = null) {
    let percent;
    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (phase === 'running') percent = Math.min(99, percent);
    } else {
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }
    if (phase === 'done')    percent = 100;
    if (phase === 'stopped') percent = total ? Math.min(95, percent) : Math.min(50, percent);

    const label = total ? `Собрано ${collected} из ${total}` : `Собрано ${collected}`;

    const payload = {
      crm_sync_percent:     percent,
      crm_sync_count:       collected,
      crm_sync_total:       total,
      crm_sync_label:       label,
      crm_sync_eta_seconds: etaSeconds,
      crm_sync_status:      phase === 'running' ? 'running' : phase,
      crm_sync_phase:       phase === 'running' ? 'scrolling' : phase
    };
    if (contacts !== null) payload.crm_contacts = contacts;

    await chrome.storage.local.set(payload);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => chrome.storage.local.set({ crm_heartbeat: Date.now() }), CFG.heartbeatInterval);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ── Главный цикл ──────────────────────────────────────────────────────────

  async function runSync(token) {
    console.log('[CRM] ══ Синхронизация v1.2 запущена ══');
    startHeartbeat();
    _cachedScrollContainer = null;
    timingWindow.length = 0;

    let allContacts = [];
    let total       = null;
    let emptyCycles = 0;
    let confirmLeft = 0;

    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    total = getTotalFromHeader();
    findScrollContainer(); // лог контейнера сразу

    if (firstBatch.length > 0) pushTiming(allContacts.length);

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(не найден)'}`);
    await reportProgress(allContacts.length, total, 'running', calcEtaSeconds(allContacts.length, total), allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) { total = found; console.log(`[CRM] Polling total: ${found}`); }
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
      } else if (total === null && emptyCycles >= CFG.maxEmptyCyclesFB) {
        console.log('[CRM] Fallback-стоп');
        break;
      } else {
        confirmLeft = 0;
      }

      const countBefore = findProfileLinks().length;
      performScroll(randomInt(CFG.scrollPxMin, CFG.scrollPxMax));

      try { await waitForNewCards(countBefore, CFG.waitNewCardsMs, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, total); return; } }

      try { await delayOrCancel(CFG.pauseAfterScroll + randomInt(0, CFG.pauseJitter), token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, total); return; } }

      if (!total) {
        const f = getTotalFromHeader();
        if (f) { total = f; console.log(`[CRM] Total в итерации: ${total}`); }
      }

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        pushTiming(allContacts.length); // обновляем окно для ETA

        const eta = calcEtaSeconds(allContacts.length, total);
        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct}) ETA=${eta ?? '?'}с`);
        await reportProgress(allContacts.length, total, 'running', eta, allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
        // ETA не пересчитываем — скорость та же, данных нет
        await reportProgress(allContacts.length, total, 'running', calcEtaSeconds(allContacts.length, total));
      }
    }

    stopHeartbeat();
    isRunning = false;

    await chrome.storage.local.set({
      crm_contacts:         allContacts,
      crm_sync_count:       allContacts.length,
      crm_sync_total:       total,
      crm_sync_percent:     100,
      crm_sync_label:       total ? `Собрано ${allContacts.length} из ${total}` : `Собрано ${allContacts.length}`,
      crm_sync_eta_seconds: null, // завершено — ETA не нужен
      crm_sync_phase:       'done',
      crm_sync_status:      'done',
      crm_sync_command:     null
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
      crm_contacts:         contacts,
      crm_sync_count:       contacts.length,
      crm_sync_total:       total,
      crm_sync_percent:     percent,
      crm_sync_label:       total ? `Собрано ${contacts.length} из ${total}` : `Собрано ${contacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'stopped',
      crm_sync_status:      'stopped',
      crm_sync_command:     null
    });
    console.log(`[CRM] Остановлено: ${contacts.length}`);
  }

  // ── Точка входа ───────────────────────────────────────────────────────────

  function startSync() {
    if (isRunning) return;
    seenUrls              = new Set();
    _cachedScrollContainer = null;
    isRunning             = true;
    currentToken          = makeStopToken();
    timingWindow.length   = 0;

    chrome.storage.local.set({
      crm_sync_status:      'running',
      crm_sync_phase:       'scrolling',
      crm_sync_percent:     1,
      crm_sync_count:       0,
      crm_sync_total:       null,
      crm_sync_label:       'Запуск…',
      crm_sync_eta_seconds: null
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
    if (!isRunning || !currentToken) return;
    currentToken.cancelled = true;
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

  if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  console.log('[CRM] content.js v1.2 готов');

})();