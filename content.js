/**
 * content.js — LinkedIn CRM v3.0
 *
 * ИЗМЕНЕНИЯ vs v2.x:
 *   - Sync собирает ТОЛЬКО firstName + lastName + profileUrl (NO auto-enrichment)
 *   - Resume dedup: при старте загружаем existingUrls из storage, пропускаем дубли
 *   - fullName разбивается splitName() → firstName + lastName
 *   - ETA считается только по scroll-времени (не по профилям)
 *   - Merge при сохранении: не перезаписываем уже enriched-поля
 */
(function () {
  'use strict';

  const SCROLL_TIME_PER_10 = 2;

  const CFG = {
    scrollPxMin:       400,
    scrollPxMax:       900,
    pauseAfterScroll:  700,
    pauseJitter:       600,
    waitNewCardsMs:    3000,
    pollTotalMs:       500,
    confirmScrolls:    2,
    maxEmptyCyclesFB:  8,
    heartbeatInterval: 4000,
    nearEndThreshold:  10,
    autoRestoreMaxAge: 30000
  };

  const STATE = { IDLE:'idle', RUNNING:'running', STOPPED:'stopped', DONE:'done', ERROR:'error' };
  let currentState = STATE.IDLE;
  function setState(s) { console.log(`[CRM] ${currentState} → ${s}`); currentState = s; }

  class CancelledError extends Error {
    constructor() { super('cancelled'); this.name = 'CancelledError'; }
  }
  function makeStopToken() { return { cancelled: false }; }
  function delayOrCancel(ms, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      const id    = setTimeout(() => { token.cancelled ? reject(new CancelledError()) : resolve(); }, ms);
      const check = setInterval(() => { if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }}, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  let currentToken           = null;
  let heartbeatTimer         = null;
  let seenUrls               = new Set();
  let existingUrls           = new Set(); // loaded from storage on start — resume dedup
  let _cachedScrollContainer = null;
  let syncSessionId          = 0;

  function randomInt(min, max) { return Math.floor(min + Math.random() * (max - min)); }

  function normalizeProfileUrl(href) {
    if (!href) return null;
    try {
      const base = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
      const m    = new URL(base).pathname.match(/^\/in\/([^/?#]+)/);
      return m ? 'https://www.linkedin.com/in/' + m[1] : null;
    } catch { return null; }
  }

  /** Split "John Doe Smith" → { firstName: "John", lastName: "Doe Smith" } */
  function splitName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
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

  // ── Scroll (connections list) ──────────────────────────────────────────

  function findScrollContainer() {
    if (_cachedScrollContainer && document.contains(_cachedScrollContainer)) return _cachedScrollContainer;
    const anchor = document.querySelector('a[href*="/in/"]');
    if (anchor) {
      let el = anchor.parentElement, depth = 0;
      while (el && el !== document.documentElement && depth < 20) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
          _cachedScrollContainer = el; return el;
        }
        el = el.parentElement; depth++;
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
    if (after === before && before > 0) _cachedScrollContainer = null;
    console.log(`[CRM] Scroll +${px}px | ${Math.round(before)}→${Math.round(after)}`);
  }

  // ── Total ──────────────────────────────────────────────────────────────

  function getTotalFromHeader() {
    const header = document.querySelector('[componentKey="ConnectionsPage_ConnectionsListHeader"]');
    if (header) {
      const num = parseConnectionCount((header.querySelector('p')?.textContent || header.textContent || '').trim());
      if (num) { console.log(`[CRM] Total: ${num}`); return num; }
    }
    const h1 = document.querySelector('main h1');
    if (h1) {
      const num = parseConnectionCount(h1.textContent || '');
      if (num) return num;
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

  // ── DOM harvest ────────────────────────────────────────────────────────

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

  /**
   * Extracts contact with firstName/lastName/profileUrl only.
   * Enrichment fields (company, jobTitle, school, major) = '' — filled later via Data tab.
   */
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
    const { firstName, lastName } = splitName(fullName);
    return { profileUrl, firstName, lastName, company: '', jobTitle: '', school: '', major: '' };
  }

  function harvestNewContacts() {
    const fresh = [];
    for (const link of findProfileLinks()) {
      const contact = extractContact(link);
      if (!contact) continue;
      if (seenUrls.has(contact.profileUrl)) continue;
      if (existingUrls.has(contact.profileUrl)) continue; // resume dedup
      seenUrls.add(contact.profileUrl);
      fresh.push(contact);
    }
    return fresh;
  }

  // ── Wait for new cards ─────────────────────────────────────────────────

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

  // ── ETA (scroll-only, no enrichment time) ─────────────────────────────

  function calcEtaSeconds(collected, total) {
    if (!total || total <= 0 || collected >= total) return null;
    return Math.round(Math.ceil((total - collected) / 10) * SCROLL_TIME_PER_10);
  }

  // ── Progress ───────────────────────────────────────────────────────────

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
    const label        = total ? `Collected ${displayCount} of ${total}` : `Collected ${collected}`;
    const etaSeconds   = (phase === 'running') ? calcEtaSeconds(collected, total) : null;

    const payload = {
      crm_sync_percent:     percent,
      crm_sync_count:       displayCount,
      crm_sync_total:       total,
      crm_sync_label:       label,
      crm_sync_eta_seconds: etaSeconds !== null ? Math.max(0, etaSeconds) : null,
      crm_sync_status:      phase === 'running' ? 'running' : phase,
      crm_sync_phase:       phase === 'running' ? 'running' : phase
    };
    if (contacts !== null) payload.crm_contacts = contacts;
    await chrome.storage.local.set(payload);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => chrome.storage.local.set({ crm_heartbeat: Date.now() }), CFG.heartbeatInterval);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ── Main sync loop — scroll-only, NO enrichment ────────────────────────

  async function runSync(token, sessionId) {
    console.log(`[CRM] Sync v3.0 — session #${sessionId}`);
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
    allContacts.push(...firstBatch);
    console.log(`[CRM] First harvest: ${firstBatch.length}. Total: ${total ?? '?'}`);
    await reportProgress(allContacts.length, total, 'running', allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) { total = found; console.log(`[CRM] Total polled: ${found}`); }
      });
    }

    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      const totalKnown = (total !== null) ? total : 0;
      const collectedAll = allContacts.length + existingUrls.size;

      if (total !== null && collectedAll >= total) {
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++; console.log(`[CRM] Confirmation scroll ${confirmLeft}/${CFG.confirmScrolls}`);
        } else { console.log(`[CRM] ✓ Done`); break; }
      } else if (total === null && emptyCycles >= CFG.maxEmptyCyclesFB) {
        console.log('[CRM] Fallback stop'); break;
      } else { confirmLeft = 0; }

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
        allContacts.push(...batch);
        console.log(`[CRM] +${batch.length} new contacts | total session: ${allContacts.length}`);

        if (total !== null && (total - allContacts.length - existingUrls.size) < CFG.nearEndThreshold) {
          await new Promise(r => setTimeout(r, 1200));
          allContacts.push(...harvestNewContacts());
          break;
        }
        await reportProgress(allContacts.length, total, 'running', null);
      } else {
        emptyCycles++;
        console.log(`[CRM] No new cards (cycle ${emptyCycles})`);
      }
    }

    stopHeartbeat();
    setState(STATE.DONE);

    // Merge: existing + new (don't overwrite enriched fields)
    const stored = await new Promise(r => chrome.storage.local.get(['crm_contacts'], d => r(d.crm_contacts || [])));
    const urlMap  = new Map(stored.map(c => [c.profileUrl, c]));
    for (const c of allContacts) {
      if (!urlMap.has(c.profileUrl)) urlMap.set(c.profileUrl, c);
    }
    const merged = Array.from(urlMap.values());

    await chrome.storage.local.set({
      crm_contacts:         merged,
      crm_sync_count:       merged.length,
      crm_sync_total:       total,
      crm_sync_percent:     100,
      crm_sync_label:       `Collected ${merged.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'done',
      crm_sync_status:      'done',
      crm_sync_command:     null
    });
    console.log(`[CRM] ✓ Done — ${allContacts.length} new, ${merged.length} total`);
  }

  async function onStopped(newContacts, total) {
    stopHeartbeat();
    setState(STATE.STOPPED);
    const stored = await new Promise(r => chrome.storage.local.get(['crm_contacts'], d => r(d.crm_contacts || [])));
    const urlMap  = new Map(stored.map(c => [c.profileUrl, c]));
    for (const c of newContacts) { if (!urlMap.has(c.profileUrl)) urlMap.set(c.profileUrl, c); }
    const merged = Array.from(urlMap.values());
    await chrome.storage.local.set({
      crm_contacts:         merged,
      crm_sync_count:       merged.length,
      crm_sync_total:       total,
      crm_sync_percent:     total ? Math.min(95, Math.round(merged.length / total * 100)) : 50,
      crm_sync_label:       `Collected ${merged.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'stopped',
      crm_sync_status:      'stopped',
      crm_sync_command:     null
    });
    console.log(`[CRM] Stopped. Saved ${merged.length} contacts.`);
  }

  // ── Entry point ────────────────────────────────────────────────────────

  function startSync() {
    if (currentState === STATE.RUNNING) { console.log('[CRM] Already running'); return; }

    // Load existing URLs for resume dedup
    chrome.storage.local.get(['crm_contacts'], data => {
      const existing = data.crm_contacts || [];
      existingUrls = new Set(existing.map(c => c.profileUrl).filter(Boolean));
      console.log(`[CRM] Resume dedup: ${existingUrls.size} existing URLs`);

      seenUrls               = new Set();
      _cachedScrollContainer = null;
      syncSessionId          = Date.now();
      currentToken           = makeStopToken();
      setState(STATE.RUNNING);

      chrome.storage.local.set({
        crm_sync_status: 'running', crm_sync_phase: 'running',
        crm_sync_percent: 1, crm_sync_count: 0,
        crm_sync_total: null, crm_sync_label: 'Starting sync…', crm_sync_eta_seconds: null
      });

      runSync(currentToken, syncSessionId).catch(err => {
        if (err instanceof CancelledError) return;
        console.error('[CRM] Critical error:', err);
        stopHeartbeat(); setState(STATE.ERROR);
        chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
      });
    });
  }

  function stopSync() {
    if (currentState !== STATE.RUNNING || !currentToken) return;
    console.log('[CRM] STOP');
    currentToken.cancelled = true;
    if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'STOP_PIPELINE' }).catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.crm_sync_command) return;
    const cmd = changes.crm_sync_command.newValue;
    if (cmd === 'start') startSync();
    if (cmd === 'stop')  stopSync();
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ alive: true, state: currentState, session: syncSessionId });
      return true;
    }
  });

  chrome.storage.local.get(['crm_sync_command', 'crm_sync_status', 'crm_heartbeat'], data => {
    const cmd    = data.crm_sync_command || null;
    const status = data.crm_sync_status  || 'idle';
    const hbAge  = Date.now() - (data.crm_heartbeat || 0);
    if (cmd === 'start' && status === 'running' && hbAge < CFG.autoRestoreMaxAge) {
      console.log('[CRM] Auto-restore'); startSync();
    } else if (cmd === 'start') {
      chrome.storage.local.set({ crm_sync_command: null });
    }
  });

  if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  console.log('[CRM] content.js v3.0 ready');

})();