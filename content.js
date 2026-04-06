/**
 * content.js — LinkedIn CRM v1.5
 *
 * Изменения:
 *   1. После каждого batch — обогащаем контакты через background (profile scraping)
 *   2. При финализации: crm_sync_count = total (если total известен)
 *   3. Пауза между профилями задаётся через CFG.profilePauseMs
 */
(function () {
  'use strict';

  const TIME_PER_10 = 2;

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
    profilePauseMs:     1800, // мс между открытием вкладок профилей
    enrichBatchSize:    20    // обогащаем не более N контактов за раз перед продолжением скролла
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

  let isRunning              = false;
  let currentToken           = null;
  let heartbeatTimer         = null;
  let seenUrls               = new Set();
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

  // ── Скролл ────────────────────────────────────────────────────────────────

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

  // ── DOM: ссылки ───────────────────────────────────────────────────────────

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

    // jobTitle/company/school — null до обогащения через profile_scraper
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

  // ── Profile enrichment через background ───────────────────────────────────

  /**
   * Отправляем batch в background, получаем обогащённые контакты.
   * background.js открывает профили поочерёдно в фоновых вкладках.
   *
   * @param {Array} batch — контакты без jobTitle/company/school
   * @param {object} token — stop token для проверки отмены
   * @returns {Promise<Array>} — обогащённые контакты (или исходные при ошибке)
   */
  function enrichBatch(batch, token) {
    return new Promise(resolve => {
      if (token.cancelled || !batch.length) {
        resolve(batch);
        return;
      }

      if (!chrome.runtime?.id) {
        resolve(batch);
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'ENRICH_CONTACTS', contacts: batch, pauseMs: CFG.profilePauseMs },
        response => {
          if (chrome.runtime.lastError || !response?.ok) {
            console.warn('[CRM] Обогащение не удалось, используем как есть:', chrome.runtime.lastError?.message);
            resolve(batch);
            return;
          }
          resolve(response.enriched || batch);
        }
      );
    });
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

  // ── ETA ───────────────────────────────────────────────────────────────────

  function calcInitialSeconds(total) {
    if (!total || total <= 0) return null;
    return Math.ceil(total / 10) * TIME_PER_10;
  }

  // ── Прогресс ──────────────────────────────────────────────────────────────

  async function reportProgress(collected, total, phase, remainingSeconds = null, contacts = null) {
    let percent;
    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (phase === 'running') percent = Math.min(99, percent);
    } else {
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }
    if (phase === 'done')    percent = 100;
    if (phase === 'stopped') percent = total ? Math.min(95, percent) : Math.min(50, percent);

    // При завершении — показываем total/total если total известен
    const displayCount = (phase === 'done' && total) ? total : collected;
    const label = total
      ? `Собрано ${displayCount} из ${total}`
      : `Собрано ${collected}`;

    const payload = {
      crm_sync_percent:     percent,
      crm_sync_count:       displayCount,
      crm_sync_total:       total,
      crm_sync_label:       label,
      crm_sync_eta_seconds: remainingSeconds !== null ? Math.max(0, remainingSeconds) : null,
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
    console.log('[CRM] ══ Синхронизация v1.5 запущена ══');
    startHeartbeat();
    _cachedScrollContainer = null;

    let allContacts      = [];
    let total            = null;
    let emptyCycles      = 0;
    let confirmLeft      = 0;
    let remainingSeconds = null;
    let lastMilestone    = 0;

    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    const firstBatch = harvestNewContacts();
    total = getTotalFromHeader();
    findScrollContainer();

    if (total) {
      remainingSeconds = calcInitialSeconds(total);
      console.log(`[CRM] ⏱ Начальный таймер: ${remainingSeconds}с`);
    }

    // Обогащаем первый batch профилями
    if (firstBatch.length > 0) {
      console.log(`[CRM] Обогащаем первый batch (${firstBatch.length} контактов)...`);
      const enriched = await enrichBatch(firstBatch.slice(0, CFG.enrichBatchSize), token);
      allContacts.push(...enriched);
    }

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(не найден)'}`);
    await reportProgress(allContacts.length, total, 'running', remainingSeconds, allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) {
          total = found;
          if (remainingSeconds === null) {
            remainingSeconds = calcInitialSeconds(found);
          }
        }
      });
    }

    // ── Основной цикл ──
    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // Условие остановки
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
        if (f) {
          total = f;
          if (remainingSeconds === null) remainingSeconds = calcInitialSeconds(f);
          console.log(`[CRM] Total в итерации: ${total}`);
        }
      }

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        emptyCycles = 0;

        // Обогащаем новый batch через profile scraping
        const toEnrich = batch.slice(0, CFG.enrichBatchSize);
        const enriched = await enrichBatch(toEnrich, token);
        allContacts.push(...enriched);

        // Если batch был больше enrichBatchSize — добавляем остаток без обогащения
        if (batch.length > CFG.enrichBatchSize) {
          allContacts.push(...batch.slice(CFG.enrichBatchSize));
        }

        // Убываем таймер
        if (remainingSeconds !== null) {
          const newMilestone = Math.floor(allContacts.length / 10) * 10;
          if (newMilestone > lastMilestone) {
            const steps = (newMilestone - lastMilestone) / 10;
            remainingSeconds = Math.max(0, remainingSeconds - steps * TIME_PER_10);
            lastMilestone    = newMilestone;
          }
        }

        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct})`);

        // Завершение при остатке < nearEndThreshold
        if (total !== null && (total - allContacts.length) < CFG.nearEndThreshold && (total - allContacts.length) >= 0) {
          console.log(`[CRM] Остаток < ${CFG.nearEndThreshold} — финальный проход`);
          await new Promise(r => setTimeout(r, 1200));
          const finalRaw     = harvestNewContacts();
          const finalEnriched = finalRaw.length > 0
            ? await enrichBatch(finalRaw, token)
            : [];
          allContacts.push(...finalEnriched);
          console.log(`[CRM] ✓ Финал: ${allContacts.length}/${total}`);
          break;
        }

        await reportProgress(allContacts.length, total, 'running', remainingSeconds, allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
        await reportProgress(allContacts.length, total, 'running', remainingSeconds);
      }
    }

    // ── Финал ──
    stopHeartbeat();
    isRunning = false;

    // При завершении: crm_sync_count = total (если total известен)
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
    seenUrls               = new Set();
    _cachedScrollContainer = null;
    isRunning              = true;
    currentToken           = makeStopToken();

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

  // ── Команды ───────────────────────────────────────────────────────────────

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

  console.log('[CRM] content.js v1.5 готов');

})();