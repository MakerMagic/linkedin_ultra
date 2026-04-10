/**
 * content.js — LinkedIn CRM v2.2
 *
 * ИСПРАВЛЕНО:
 *
 *   БАГ 1 — Singleton pipeline:
 *     if (currentState === STATE.RUNNING) return — двойной запуск заблокирован.
 *     syncSessionId гарантирует игнорирование устаревших async ответов.
 *
 *   БАГ 4 — Stop = полный kill:
 *     stopSync() отменяет token И отправляет STOP_PIPELINE в background.
 *     background.js вызывает killPipeline() → закрывает активную вкладку профиля.
 *     В каждом await: проверяем token.cancelled.
 *
 *   Прочее:
 *     - label на английском ("Collected X of Y")
 *     - autoRestoreMaxAge 30 сек — автовосстановление только при свежем heartbeat
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const SECONDS_PER_PROFILE = 4;
  const SCROLL_TIME_PER_10  = 2;

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
    nearEndThreshold:   10,
    profilePauseMs:     700,
    enrichBatchSize:    20,
    autoRestoreMaxAge:  30000
  };

  // =====================================================================
  // STATE MACHINE
  // =====================================================================

  const STATE = {
    IDLE:    'idle',
    RUNNING: 'running',
    STOPPED: 'stopped',
    DONE:    'done',
    ERROR:   'error'
  };

  let currentState = STATE.IDLE;

  function setState(s) {
    console.log(`[CRM] State: ${currentState} → ${s}`);
    currentState = s;
  }

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
      // Проверяем каждые 50мс — быстрая реакция на stop
      const check = setInterval(() => {
        if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  // =====================================================================
  // ГЛОБАЛЬНОЕ СОСТОЯНИЕ
  // =====================================================================

  let currentToken           = null;
  let heartbeatTimer         = null;
  let seenUrls               = new Set();
  let _cachedScrollContainer = null;

  /**
   * syncSessionId — уникальный ID сессии.
   * Генерируется при каждом startSync().
   * enrichBatch игнорирует ответы от устаревших сессий.
   */
  let syncSessionId = 0;

  // =====================================================================
  // УТИЛИТЫ
  // =====================================================================

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

  // =====================================================================
  // СКРОЛЛ
  // =====================================================================

  function findScrollContainer() {
    if (_cachedScrollContainer && document.contains(_cachedScrollContainer)) return _cachedScrollContainer;
    const anchor = document.querySelector('a[href*="/in/"]');
    if (anchor) {
      let el = anchor.parentElement;
      let depth = 0;
      while (el && el !== document.documentElement && depth < 20) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
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
    console.log(`[CRM] Scroll +${px}px | ${Math.round(before)}→${Math.round(after)}`);
  }

  // =====================================================================
  // TOTAL
  // =====================================================================

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

  // =====================================================================
  // DOM: ССЫЛКИ И КОНТАКТЫ
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

    return { profileUrl, fullName, jobTitle: '', company: '', school: '', major: '' };
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
  // ОБОГАЩЕНИЕ ЧЕРЕЗ BACKGROUND
  // =====================================================================

  function enrichBatch(batch, token) {
    return new Promise(resolve => {
      if (token.cancelled || !batch.length) { resolve(batch); return; }
      if (!chrome.runtime?.id) { resolve(batch); return; }

      const sessionAtSend = syncSessionId;

      chrome.runtime.sendMessage(
        { type: 'ENRICH_CONTACTS', contacts: batch, pauseMs: CFG.profilePauseMs },
        response => {
          // Сессия сменилась → старый ответ игнорируем
          if (syncSessionId !== sessionAtSend) {
            console.log('[CRM] enrichBatch: stale session — ignoring');
            resolve(batch);
            return;
          }
          if (chrome.runtime.lastError || !response?.ok) {
            // already_running — тоже возвращаем исходный batch
            console.warn('[CRM] Enrichment failed:', chrome.runtime.lastError?.message || response?.reason);
            resolve(batch);
            return;
          }
          resolve(response.enriched || batch);
        }
      );
    });
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
        if (done) return; done = true;
        clearTimeout(timer); clearInterval(cancelCheck); obs.disconnect();
        token.cancelled ? reject(new CancelledError()) : resolve(reason);
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
  // ETA
  // =====================================================================

  function calcEtaSeconds(collected, total) {
    if (!total || total <= 0 || collected >= total) return null;
    const remaining = total - collected;
    return Math.round(Math.ceil(remaining / 10) * SCROLL_TIME_PER_10 + remaining * SECONDS_PER_PROFILE);
  }

  // =====================================================================
  // ПРОГРЕСС В STORAGE
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

    const displayCount = (phase === 'done' && total) ? total : collected;
    // Метка на английском — dashboard.js покажет её напрямую
    const label = total
      ? `Collected ${displayCount} of ${total}`
      : `Collected ${collected}`;

    const etaSeconds = (phase === 'running') ? calcEtaSeconds(collected, total) : null;

    const payload = {
      crm_sync_percent:     percent,
      crm_sync_count:       displayCount,
      crm_sync_total:       total,
      crm_sync_label:       label,
      crm_sync_eta_seconds: etaSeconds !== null ? Math.max(0, etaSeconds) : null,
      crm_sync_status:      phase === 'running' ? 'running' : phase,
      crm_sync_phase:       phase === 'running' ? 'scrolling' : phase
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

  async function runSync(token, sessionId) {
    console.log(`[CRM] ══ Sync v2.2 started (session #${sessionId}) ══`);
    startHeartbeat();
    _cachedScrollContainer = null;

    let allContacts = [];
    let total       = null;
    let emptyCycles = 0;
    let confirmLeft = 0;

    if (findProfileLinks().length === 0) {
      console.log('[CRM] Waiting for first cards...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    const firstBatch = harvestNewContacts();
    total = getTotalFromHeader();
    findScrollContainer();

    if (firstBatch.length > 0) {
      console.log(`[CRM] Enriching first batch (${firstBatch.length})...`);
      const enriched = await enrichBatch(firstBatch.slice(0, CFG.enrichBatchSize), token);
      if (token.cancelled) { await onStopped([...allContacts, ...enriched], total); return; }
      allContacts.push(...enriched);
      if (firstBatch.length > CFG.enrichBatchSize) {
        allContacts.push(...firstBatch.slice(CFG.enrichBatchSize));
      }
    }

    console.log(`[CRM] First harvest: ${firstBatch.length}. Total: ${total ?? '(not found)'}`);
    await reportProgress(allContacts.length, total, 'running', allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) {
          total = found;
          console.log(`[CRM] Polling total: ${found}`);
        }
      });
    }

    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      if (total !== null && allContacts.length >= total) {
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++;
          console.log(`[CRM] Confirmation scroll ${confirmLeft}/${CFG.confirmScrolls}`);
        } else {
          console.log(`[CRM] ✓ Done: ${allContacts.length} >= ${total}`);
          break;
        }
      } else if (total === null && emptyCycles >= CFG.maxEmptyCyclesFB) {
        console.log('[CRM] Fallback stop');
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
        if (f) { total = f; console.log(`[CRM] Total found: ${total}`); }
      }

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        emptyCycles = 0;

        const toEnrich = batch.slice(0, CFG.enrichBatchSize);
        const enriched = await enrichBatch(toEnrich, token);

        if (token.cancelled) { await onStopped([...allContacts, ...enriched, ...batch.slice(CFG.enrichBatchSize)], total); return; }

        allContacts.push(...enriched);
        if (batch.length > CFG.enrichBatchSize) {
          allContacts.push(...batch.slice(CFG.enrichBatchSize));
        }

        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct}) ETA=${calcEtaSeconds(allContacts.length, total) ?? '?'}s`);

        if (total !== null && (total - allContacts.length) < CFG.nearEndThreshold && (total - allContacts.length) >= 0) {
          console.log(`[CRM] Remainder < ${CFG.nearEndThreshold} — final pass`);
          await new Promise(r => setTimeout(r, 1200));
          const finalRaw      = harvestNewContacts();
          const finalEnriched = finalRaw.length > 0 ? await enrichBatch(finalRaw, token) : [];
          allContacts.push(...finalEnriched);
          console.log(`[CRM] ✓ Final: ${allContacts.length}/${total}`);
          break;
        }

        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] No new cards (${emptyCycles}${total ? `, remaining: ${total - allContacts.length}` : ''})`);
        await reportProgress(allContacts.length, total, 'running');
      }
    }

    stopHeartbeat();
    setState(STATE.DONE);

    const finalCount = (total && total > 0) ? total : allContacts.length;
    await chrome.storage.local.set({
      crm_contacts:         allContacts,
      crm_sync_count:       finalCount,
      crm_sync_total:       total,
      crm_sync_percent:     100,
      crm_sync_label:       total ? `Collected ${finalCount} of ${total}` : `Collected ${allContacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'done',
      crm_sync_status:      'done',
      crm_sync_command:     null
    });

    console.log(`[CRM] ✓ Done (session #${sessionId}): ${allContacts.length}${total ? `/${total}` : ''}`);
  }

  async function onStopped(contacts, total) {
    stopHeartbeat();
    setState(STATE.STOPPED);

    const percent = (total && total > 0)
      ? Math.min(95, Math.round((contacts.length / total) * 100))
      : Math.min(15, contacts.length > 0 ? Math.round(contacts.length / 10) : 0);

    await chrome.storage.local.set({
      crm_contacts:         contacts,
      crm_sync_count:       contacts.length,
      crm_sync_total:       total,
      crm_sync_percent:     percent,
      crm_sync_label:       total ? `Collected ${contacts.length} of ${total}` : `Collected ${contacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'stopped',
      crm_sync_status:      'stopped',
      crm_sync_command:     null
    });
    console.log(`[CRM] Stopped: ${contacts.length}`);
  }

  // =====================================================================
  // ТОЧКА ВХОДА
  // =====================================================================

  function startSync() {
    // ── SINGLETON GUARD ──
    if (currentState === STATE.RUNNING) {
      console.log('[CRM] Already running — ignoring duplicate start');
      return;
    }

    seenUrls               = new Set();
    _cachedScrollContainer = null;
    syncSessionId          = Date.now();
    currentToken           = makeStopToken();
    setState(STATE.RUNNING);

    console.log(`[CRM] startSync() session #${syncSessionId}`);

    chrome.storage.local.set({
      crm_sync_status:      'running',
      crm_sync_phase:       'scrolling',
      crm_sync_percent:     1,
      crm_sync_count:       0,
      crm_sync_total:       null,
      crm_sync_label:       'Starting…',
      crm_sync_eta_seconds: null
    });

    runSync(currentToken, syncSessionId).catch(err => {
      if (err instanceof CancelledError) return;
      console.error('[CRM] Critical error:', err);
      stopHeartbeat();
      setState(STATE.ERROR);
      chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
    });
  }

  function stopSync() {
    if (currentState !== STATE.RUNNING || !currentToken) return;
    console.log('[CRM] STOP → cancelling token + sending STOP_PIPELINE');

    // 1. Отменяем токен — прерывает все await в runSync
    currentToken.cancelled = true;

    // 2. Сообщаем background — тот убьёт активную вкладку профиля
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'STOP_PIPELINE' }).catch(() => {});
    }
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
    if (msg.type === 'PING') {
      sendResponse({ alive: true, state: currentState, session: syncSessionId });
      return true;
    }
  });

  // =====================================================================
  // ИНИЦИАЛИЗАЦИЯ
  // =====================================================================

  chrome.storage.local.get(
    ['crm_sync_command', 'crm_sync_status', 'crm_heartbeat'],
    data => {
      const cmd    = data.crm_sync_command || null;
      const status = data.crm_sync_status  || 'idle';
      const hbAge  = Date.now() - (data.crm_heartbeat || 0);

      const wasRunning = cmd === 'start' && status === 'running';
      const hbFresh    = hbAge < CFG.autoRestoreMaxAge;

      if (wasRunning && hbFresh) {
        console.log(`[CRM] Auto-restore (heartbeat ${Math.round(hbAge / 1000)}s ago)`);
        startSync();
      } else if (cmd === 'start') {
        console.log('[CRM] Stale start command — resetting');
        chrome.storage.local.set({ crm_sync_command: null });
      }
    }
  );

  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v2.2 ready');

})();