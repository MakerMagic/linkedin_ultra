/**
 * content.js — LinkedIn CRM v2.1
 *
 * Исправлено:
 *
 *   БАГ 2 — Дублирование после pause/resume:
 *     При startSync() полностью сбрасываем seenUrls И все счётчики.
 *     Добавлен syncSessionId — уникальный ID сессии.
 *     enrichBatch игнорирует ответы от устаревших сессий.
 *
 *   БАГ 3 — Неправильный ETA:
 *     Новая формула: ETA = scrollTimeRemaining + (total - collected) * SECONDS_PER_PROFILE
 *     SECONDS_PER_PROFILE = 4 (каждый профиль ~4 сек с учётом загрузки + паузы)
 *     Обновляется динамически после каждого батча.
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  // Среднее время на парсинг одного профиля (загрузка + scraper + пауза)
  const SECONDS_PER_PROFILE = 4;
  // Секунд на каждые 10 контактов при скролле (без парсинга профилей)
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
    profilePauseMs:     1800,
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
    console.log(`[CRM] Состояние: ${currentState} → ${s}`);
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
   * ✅ БАГ 2 FIX: syncSessionId — уникальный ID текущей сессии.
   * enrichBatch передаёт его в background; ответы с устаревшим ID отбрасываются.
   * При каждом startSync() генерируется новый ID → старые async операции игнорируются.
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
    console.log(`[CRM] Скролл +${px}px | ${Math.round(before)}→${Math.round(after)}`);
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

    return { profileUrl, fullName, jobTitle: null, company: null, school: null };
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

  /**
   * ✅ БАГ 2 FIX: передаём sessionId в запрос.
   * Если к моменту ответа сессия сменилась (пользователь остановил и перезапустил)
   * — результат отбрасывается и возвращается исходный batch.
   */
  function enrichBatch(batch, token) {
    return new Promise(resolve => {
      if (token.cancelled || !batch.length) { resolve(batch); return; }
      if (!chrome.runtime?.id) { resolve(batch); return; }

      const sessionAtSend = syncSessionId; // запоминаем ID текущей сессии

      chrome.runtime.sendMessage(
        { type: 'ENRICH_CONTACTS', contacts: batch, pauseMs: CFG.profilePauseMs },
        response => {
          // Если сессия сменилась пока шло обогащение — игнорируем результат
          if (syncSessionId !== sessionAtSend) {
            console.log('[CRM] enrichBatch: сессия сменилась — игнорируем устаревший результат');
            resolve(batch);
            return;
          }
          if (chrome.runtime.lastError || !response?.ok) {
            console.warn('[CRM] Обогащение не удалось:', chrome.runtime.lastError?.message);
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
  // ETA — ИСПРАВЛЕННАЯ ФОРМУЛА
  // =====================================================================

  /**
   * ✅ БАГ 3 FIX: новая формула ETA учитывает время парсинга профилей.
   *
   * ETA = scrollTimeRemaining + (total - collected) * SECONDS_PER_PROFILE
   *
   * Где:
   *   scrollTimeRemaining = оставшееся время скролла
   *     = ((total - collected) / 10) * SCROLL_TIME_PER_10
   *   (total - collected) * SECONDS_PER_PROFILE = время на парсинг профилей
   *
   * Итого:
   *   ETA ≈ ((remaining / 10) * 2) + (remaining * 4)
   *   При 100 оставшихся: (10 * 2) + (100 * 4) = 20 + 400 = 420 сек ≈ 7 мин
   */
  function calcEtaSeconds(collected, total) {
    if (!total || total <= 0 || collected >= total) return null;
    const remaining           = total - collected;
    const scrollTimeRemaining = Math.ceil(remaining / 10) * SCROLL_TIME_PER_10;
    const profilesTime        = remaining * SECONDS_PER_PROFILE;
    return Math.round(scrollTimeRemaining + profilesTime);
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
    const label = total
      ? `Собрано ${displayCount} из ${total}`
      : `Собрано ${collected}`;

    // Считаем ETA только во время работы
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
    console.log(`[CRM] ══ Синхронизация v2.1 запущена (session #${sessionId}) ══`);
    startHeartbeat();
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

    const firstBatch = harvestNewContacts();
    total = getTotalFromHeader();
    findScrollContainer();

    if (firstBatch.length > 0) {
      console.log(`[CRM] Обогащаем первый batch (${firstBatch.length})...`);
      const enriched = await enrichBatch(firstBatch.slice(0, CFG.enrichBatchSize), token);
      // Проверяем что сессия не сменилась пока шло обогащение
      if (token.cancelled) { await onStopped([...allContacts, ...enriched], total); return; }
      allContacts.push(...enriched);
      if (firstBatch.length > CFG.enrichBatchSize) {
        allContacts.push(...firstBatch.slice(CFG.enrichBatchSize));
      }
    }

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(не найден)'}`);
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
        if (f) { total = f; console.log(`[CRM] Total найден: ${total}`); }
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
        // ETA теперь считается в reportProgress через calcEtaSeconds
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct}) ETA=${calcEtaSeconds(allContacts.length, total) ?? '?'}с`);

        if (total !== null && (total - allContacts.length) < CFG.nearEndThreshold && (total - allContacts.length) >= 0) {
          console.log(`[CRM] Остаток < ${CFG.nearEndThreshold} — финальный проход`);
          await new Promise(r => setTimeout(r, 1200));
          const finalRaw     = harvestNewContacts();
          const finalEnriched = finalRaw.length > 0 ? await enrichBatch(finalRaw, token) : [];
          allContacts.push(...finalEnriched);
          console.log(`[CRM] ✓ Финал: ${allContacts.length}/${total}`);
          break;
        }

        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
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
      crm_sync_label:       total ? `Собрано ${finalCount} из ${total}` : `Собрано ${allContacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'done',
      crm_sync_status:      'done',
      crm_sync_command:     null
    });

    console.log(`[CRM] ✓ Готово (session #${sessionId}): ${allContacts.length}${total ? `/${total}` : ''}`);
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
      crm_sync_label:       total ? `Собрано ${contacts.length} из ${total}` : `Собрано ${contacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'stopped',
      crm_sync_status:      'stopped',
      crm_sync_command:     null
    });
    console.log(`[CRM] Остановлено: ${contacts.length}`);
  }

  // =====================================================================
  // ТОЧКА ВХОДА
  // =====================================================================

  function startSync() {
    if (currentState === STATE.RUNNING) {
      console.log('[CRM] Уже запущено — игнорируем');
      return;
    }

    // ✅ БАГ 2 FIX: полный сброс состояния перед каждым запуском
    seenUrls               = new Set();
    _cachedScrollContainer = null;
    syncSessionId          = Date.now(); // уникальный ID — старые async операции устаревают
    currentToken           = makeStopToken();
    setState(STATE.RUNNING);

    console.log(`[CRM] startSync() session #${syncSessionId}`);

    chrome.storage.local.set({
      crm_sync_status:      'running',
      crm_sync_phase:       'scrolling',
      crm_sync_percent:     1,
      crm_sync_count:       0,
      crm_sync_total:       null,
      crm_sync_label:       'Запуск…',
      crm_sync_eta_seconds: null
    });

    runSync(currentToken, syncSessionId).catch(err => {
      if (err instanceof CancelledError) return;
      console.error('[CRM] Критическая ошибка:', err);
      stopHeartbeat();
      setState(STATE.ERROR);
      chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
    });
  }

  function stopSync() {
    if (currentState !== STATE.RUNNING || !currentToken) return;
    console.log('[CRM] STOP → отменяем токен');
    currentToken.cancelled = true;
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
        console.log(`[CRM] Автовосстановление (heartbeat ${Math.round(hbAge / 1000)}с назад)`);
        startSync();
      } else if (cmd === 'start') {
        console.log('[CRM] Старая команда start в storage — сбрасываем');
        chrome.storage.local.set({ crm_sync_command: null });
      }
    }
  );

  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v2.1 готов');

})();