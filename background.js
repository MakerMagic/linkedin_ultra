/**
 * background.js — LinkedIn CRM v2.5
 *
 * Точечные исправления поверх v2.4:
 *
 *   ПРАВКА 1 — Скролл профиля (ПРОБЛЕМА 1):
 *     Заменяем условный scroll (проверял scrollHeight) на
 *     фиксированную серию: 5 скроллов × 600мс БЕЗ каких-либо условий остановки.
 *     LinkedIn SPA требует повторных скроллов — одного недостаточно.
 *
 *   ПРАВКА 2 — Остановка при закрытии (ПРОБЛЕМА 2):
 *     Добавляем canContinuePipeline() — проверяется ПЕРЕД КАЖДЫМ профилем.
 *     Проверяет: жива ли вкладка connections.
 *     Если нет → killPipeline + немедленный return.
 *
 * Всё остальное из v2.4 — НЕ ТРОНУТО.
 */

const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const LINKEDIN_GROW_PATTERNS = [
  'https://www.linkedin.com/mynetwork/grow/',
  'https://www.linkedin.com/mynetwork/grow/*'
];
const DASHBOARD_PATH = 'dashboard.html';

// ── ГЛОБАЛЬНЫЙ SINGLETON STATE ────────────────────────────────────────────

const G = {
  isRunning:           false,
  isStopped:           false,
  activeProfileTabId:  null,
  connectionsTabId:    null,
  connectionsWindowId: chrome.windows.WINDOW_ID_NONE
};

const growScrolledTabs = new Set();

function isGrowUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.origin === 'https://www.linkedin.com' && u.pathname.indexOf('/mynetwork/grow') === 0;
  } catch {
    return false;
  }
}

async function triggerGrowScroll(tabId) {
  let zoomChanged = false;
  try {
    console.log('[CRM BG] Grow: waiting 2000ms before scroll');
    await delay(2000);

    async function getLocalStorage(keys) {
      return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }

    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { return; }

    try {
      if (tab?.windowId !== undefined && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      console.warn('[CRM BG] Grow: could not focus tab:', e?.message || e);
    }

    await delay(300);

    function randomInt(min, max) {
      return Math.floor(min + Math.random() * (max - min));
    }

    async function zoomStep(zoomValue) {
      try {
        await chrome.tabs.setZoom(tabId, zoomValue);
        zoomChanged = true;
        console.log('[CRM BG] Grow: zoom', Math.round(zoomValue * 100) + '%');
      } catch (e) {
        console.warn('[CRM BG] Grow: setZoom failed:', e?.message || e);
      }
      await delay(randomInt(500, 1001));
    }

    await zoomStep(0.75);
    await zoomStep(0.5);
    await zoomStep(0.25);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const scrollingEl = document.scrollingElement || document.documentElement;
        scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
        void document.body.offsetHeight;
        scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
      }
    });

    const snap = await getLocalStorage(['crm_networking_keywords', 'crm_sent_invites', 'crm_networking_read_log']);
    const keywords = Array.isArray(snap.crm_networking_keywords) ? snap.crm_networking_keywords : [];
    const sentInvites = Array.isArray(snap.crm_sent_invites) ? snap.crm_sent_invites : [];
    const readLog = Array.isArray(snap.crm_networking_read_log) ? snap.crm_networking_read_log : [];
    const sentUrls = sentInvites.map(x => x && (x.profileUrl || x.url || x.href)).filter(Boolean);
    const readUrls = readLog.map(x => x && (x.profileUrl || x.url || x.href)).filter(Boolean);

    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (netKeywords, existingSentUrls, existingReadUrls) => {

        function sleep(ms) {
          return new Promise(r => setTimeout(r, ms));
        }

        function safeText(s) {
          return (s || '').replace(/\s+/g, ' ').trim();
        }

        function normalizeUrl(href) {
          if (!href) return '';
          try {
            if (href.startsWith('http')) return href;
            if (href.startsWith('/')) return new URL(href, location.origin).toString();
            return new URL(href, location.origin).toString();
          } catch {
            return '';
          }
        }

        function splitName(fullName) {
          const t = safeText(fullName);
          if (!t) return { firstName: '', lastName: '' };
          const parts = t.split(/\s+/);
          if (parts.length === 1) return { firstName: parts[0], lastName: '' };
          return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
        }

        const keywords = Array.isArray(netKeywords) ? netKeywords.map(k => safeText(String(k)).toLowerCase()).filter(Boolean) : [];
        const sentSet = new Set(Array.isArray(existingSentUrls) ? existingSentUrls.map(u => String(u)) : []);
        const readSet = new Set(Array.isArray(existingReadUrls) ? existingReadUrls.map(u => String(u)) : []);
        const sessionInvited = new Set();
        const newInvites = [];
        const readEntries = [];
        const sessionRead = new Set();

        function findTargetSection() {
          const sections = Array.from(document.querySelectorAll('section[componentkey], section[componentKey]'));
          for (const section of sections) {
            const key = (section.getAttribute('componentkey') || section.getAttribute('componentKey') || '').toLowerCase();
            if (!key.includes('auto-component')) continue;

            const h3 = section.querySelector('h3');
            const h3Text = (h3 && h3.textContent ? h3.textContent : '').trim();
            if (h3Text.toLowerCase().includes('popular')) continue;

            return section;
          }
          return null;
        }

        function findShowAllLink(section) {
          const links = Array.from(section.querySelectorAll('a[aria-label]'));
          for (const a of links) {
            const label = (a.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('show all')) return a;
          }
          return null;
        }

        function findDialogScrollContainer(d) {
          const all = [d, ...Array.from(d.querySelectorAll('*'))];
          let best = d;
          let bestDist = 0;

          for (const el of all) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.clientHeight < 200) continue;
            const dist = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
            if (dist < 100) continue;

            const style = window.getComputedStyle(el);
            const ov = (style && style.overflowY) ? style.overflowY : '';
            const isScrollable = ov === 'auto' || ov === 'scroll' || dist >= 300;
            if (!isScrollable) continue;

            if (dist > bestDist) {
              best = el;
              bestDist = dist;
            }
          }
          return best;
        }

        function wheelScroll(el, deltaY) {
          try {
            const evt = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
            el.dispatchEvent(evt);
          } catch {
            // ignore
          }
        }

        function collectProfileAnchors(d) {
          // LinkedIn часто использует относительные ссылки вида "/in/..."
          const all = Array.from(d.querySelectorAll('a[href*="/in/"], a[href*="linkedin.com/in"]'));
          return all;
        }

        function extractNameAndBioFromAnchor(a) {
          try {
            // 1) Name (максимально устойчиво к изменениям DOM)
            let name = '';

            // Часто имя лежит в span[aria-hidden="true"] внутри ссылки
            const ariaHiddenSpans = Array.from(a.querySelectorAll('span[aria-hidden="true"]'));
            for (const sp of ariaHiddenSpans) {
              const t = safeText(sp.textContent);
              if (t && t.length >= 2) {
                name = t;
                break;
              }
            }

            // Фоллбек: первый осмысленный текстовый span
            if (!name) {
              const spans = Array.from(a.querySelectorAll('span'));
              for (const sp of spans) {
                const t = safeText(sp.textContent);
                if (t && t.length >= 2) {
                  name = t;
                  break;
                }
              }
            }

            // Фоллбек: первый p
            if (!name) {
              const p = a.querySelector('p');
              const t = safeText(p ? p.textContent : '');
              if (t && t.length >= 2) name = t;
            }

            // Фоллбек: весь текст ссылки (последний шанс)
            if (!name) {
              const t = safeText(a.textContent);
              if (t && t.length >= 2) name = t;
            }

            name = safeText((name || '').split(',')[0]);
            if (!name) return null;

            // 2) Bio (вторая строка карточки, либо ближайший p/second span)
            let bio = '';

            // Попытка: взять самый “длинный” p внутри anchor, который не равен name
            const ps = Array.from(a.querySelectorAll('p'));
            let best = '';
            for (const p of ps) {
              const t = safeText(p.textContent);
              if (!t) continue;
              if (t === name) continue;
              if (t.length > best.length) best = t;
            }
            if (best) bio = best;

            // Фоллбек: второй осмысленный span
            if (!bio) {
              const spans = Array.from(a.querySelectorAll('span'));
              let seenNameLike = false;
              for (const sp of spans) {
                const t = safeText(sp.textContent);
                if (!t) continue;
                if (!seenNameLike && (t === name || t.includes(name))) {
                  seenNameLike = true;
                  continue;
                }
                if (seenNameLike && t !== name) {
                  bio = t;
                  break;
                }
              }
            }

            return { name, bio };
          } catch {
            return null;
          }
        }

        function matchesKeywords(bio) {
          if (!keywords.length) return true;
          const b = safeText(bio).toLowerCase();
          if (!b) return false;
          for (const kw of keywords) {
            if (kw && b.includes(kw)) return true;
          }
          return false;
        }

        function findInviteButtonForAnchor(a) {
          try {
            const next = a.nextElementSibling;
            if (!next || next.tagName !== 'DIV') return null;
            const divs = Array.from(next.children).filter(ch => ch && ch.tagName === 'DIV');
            const maybe = divs[1] || next;
            const btn = maybe.querySelector('button[aria-label]');
            if (!btn) return null;
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (!label.includes('invite')) return null;
            return btn;
          } catch {
            return null;
          }
        }

        function rememberRead(href, name, bio, matched, invited) {
          if (!href) return;
          if (readSet.has(href)) return;
          if (sessionRead.has(href)) return;
          sessionRead.add(href);
          const n = splitName(name);
          readEntries.push({
            firstName: n.firstName,
            lastName: n.lastName,
            profileUrl: href,
            bio: bio,
            matched: !!matched,
            invited: !!invited
          });
        }

        async function processDialogProfiles(d) {
          const anchors = collectProfileAnchors(d);
          for (const a of anchors) {
            const href = normalizeUrl(a.getAttribute('href'));
            if (!href) continue;

            const parsed = extractNameAndBioFromAnchor(a);
            if (!parsed) continue;

            const matched = matchesKeywords(parsed.bio);

            if (sentSet.has(href)) {
              rememberRead(href, parsed.name, parsed.bio, matched, true);
              continue;
            }
            if (sessionInvited.has(href)) {
              rememberRead(href, parsed.name, parsed.bio, matched, true);
              continue;
            }

            if (!matched) {
              rememberRead(href, parsed.name, parsed.bio, false, false);
              continue;
            }

            const btn = findInviteButtonForAnchor(a);
            if (!btn) {
              rememberRead(href, parsed.name, parsed.bio, true, false);
              continue;
            }

            try {
              btn.click();
              sessionInvited.add(href);
              const n = splitName(parsed.name);
              newInvites.push({
                firstName: n.firstName,
                lastName: n.lastName,
                profileUrl: href,
                bio: parsed.bio
              });
              rememberRead(href, parsed.name, parsed.bio, true, true);
              await sleep(200);
            } catch {
              // ignore
            }
          }
        }

        const section = findTargetSection();
        if (!section) return { ok: false, step: 'find_section', reason: 'not_found', newInvites, readEntries };

        const link = findShowAllLink(section);
        if (!link) return { ok: false, step: 'find_show_all', reason: 'not_found', newInvites, readEntries };

        link.click();

        let dialog = null;
        for (let i = 0; i < 30; i++) {
          dialog = document.querySelector('dialog[data-testid="dialog"][aria-labelledby="dialog-header"]')
            || document.querySelector('[role="dialog"][aria-labelledby="dialog-header"], [aria-modal="true"][aria-labelledby="dialog-header"]')
            || document.querySelector('dialog[data-testid="dialog"]')
            || document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (dialog) break;
          await sleep(200);
        }

        if (!dialog) return { ok: false, step: 'dialog_open', reason: 'timeout', newInvites, readEntries };

        // STEP 7 — wait for contacts load
        await sleep(5000);

        // STEP 8 — scroll inside dialog (not body)
        const scrollable = findDialogScrollContainer(dialog);
        try {
          scrollable.focus({ preventScroll: true });
        } catch {
          // ignore
        }

        const iterations = 10;
        for (let i = 1; i <= iterations; i++) {
          const before = scrollable.scrollTop;
          try {
            scrollable.scrollBy({ top: 600, behavior: 'smooth' });
          } catch {
            scrollable.scrollTop += 600;
          }

          // If LinkedIn ignores programmatic scroll, wheel often triggers lazy-load
          await sleep(150);
          if (scrollable.scrollTop === before) {
            wheelScroll(scrollable, 800);
            await sleep(50);
            wheelScroll(scrollable, 800);
            try { scrollable.scrollTop += 600; } catch { /* ignore */ }
          }

          await sleep(1000);

          // Process visible profiles after each scroll step (do not interrupt scrolling loop)
          await processDialogProfiles(dialog);
        }

        // STEP 9 — close dialog
        const headerDialog = document.querySelector('dialog[data-testid="dialog"][aria-labelledby="dialog-header"], dialog[data-testid="dialog"], [role="dialog"][aria-labelledby="dialog-header"], [aria-modal="true"][aria-labelledby="dialog-header"]');
        if (!headerDialog) return { ok: false, step: 'close_dialog', reason: 'dialog_not_found', newInvites, readEntries };

        const dismiss = headerDialog.querySelector('button[aria-label="Dismiss"]');
        if (!dismiss) return { ok: false, step: 'close_dialog', reason: 'dismiss_not_found', newInvites, readEntries };

        dismiss.click();
        await sleep(500);
        return { ok: true, step: 'done', newInvites, readEntries };
      }
      ,
      args: [keywords, sentUrls, readUrls]
    });

    const first = Array.isArray(result) ? result[0] : null;
    const payload = first?.result;
    if (payload?.ok) {
      console.log('[CRM BG] Grow: Show all clicked, dialog open');
    } else {
      console.warn('[CRM BG] Grow: step failed:', payload);
    }

    if (Array.isArray(payload?.readEntries) && payload.readEntries.length) {
      const merged = [...readLog];
      const existing = new Set(merged.map(x => x && (x.profileUrl || x.url || x.href)).filter(Boolean));
      for (const item of payload.readEntries) {
        const u = item && (item.profileUrl || item.url || item.href);
        if (!u || existing.has(u)) continue;
        existing.add(u);
        merged.push(item);
      }
      const capped = merged.length > 2000 ? merged.slice(merged.length - 2000) : merged;
      await chrome.storage.local.set({ crm_networking_read_log: capped });
      console.log('[CRM BG] Grow: saved read log items:', payload.readEntries.length);
    }

    if (payload?.ok && Array.isArray(payload.newInvites) && payload.newInvites.length) {
      const merged = [...sentInvites];
      const existing = new Set(merged.map(x => x && (x.profileUrl || x.url || x.href)).filter(Boolean));
      for (const inv of payload.newInvites) {
        const u = inv && (inv.profileUrl || inv.url || inv.href);
        if (!u || existing.has(u)) continue;
        existing.add(u);
        merged.push(inv);
      }
      await chrome.storage.local.set({ crm_sent_invites: merged });
      console.log('[CRM BG] Grow: saved new invites:', payload.newInvites.length);
    }

    console.log('[CRM BG] Grow: scroll done');
  } catch (err) {
    console.warn('[CRM BG] Grow: scroll failed:', err?.message || err);
  } finally {
    void zoomChanged;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isGrowUrl(tab.url)) {
    if (growScrolledTabs.has(tabId)) growScrolledTabs.delete(tabId);
    return;
  }
  if (growScrolledTabs.has(tabId)) return;
  growScrolledTabs.add(tabId);
  triggerGrowScroll(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (growScrolledTabs.has(tabId)) growScrolledTabs.delete(tabId);
});

async function killPipeline(reason) {
  console.log(`[CRM BG] ⛔ Kill pipeline: ${reason}`);
  G.isStopped = true;
  G.isRunning  = false;

  if (G.activeProfileTabId !== null) {
    try { await chrome.tabs.remove(G.activeProfileTabId); } catch { /* уже закрыта */ }
    G.activeProfileTabId = null;
  }
}

// ── Утилиты ───────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ПРАВКА 2: Проверка перед каждым профилем ─────────────────────────────

/**
 * Проверяет, можно ли продолжать открывать профили.
 *
 * Условие: вкладка connections должна существовать.
 * Если пользователь закрыл её — останавливаемся.
 *
 * Мягкая проверка: не завязывается на popup/dashboard (он может закрываться).
 */
async function canContinuePipeline() {
  // Если уже остановлено — не проверяем дальше
  if (G.isStopped) return false;

  // Проверяем что вкладка connections ещё существует
  try {
    const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
    if (tabs.length === 0) {
      console.log('[CRM BG] ⛔ Connections tab closed — stopping pipeline');
      await killPipeline('connections tab closed');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[CRM BG] canContinuePipeline check failed:', err);
    return false; // при ошибке — безопаснее остановить
  }
}

// ── Управление вкладкой Connections ──────────────────────────────────────

async function getOrCreateConnectionsTab() {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });

    if (existing.length > 1) {
      const dups = existing.slice(1).map(t => t.id).filter(Boolean);
      await chrome.tabs.remove(dups);
      console.log(`[CRM BG] Closed ${dups.length} duplicate connection tabs`);
    }

    if (existing.length >= 1) {
      G.connectionsTabId    = existing[0].id;
      G.connectionsWindowId = existing[0].windowId;
      console.log(`[CRM BG] Window ID: ${G.connectionsWindowId} | Tab ID: ${G.connectionsTabId}`);
      return { tabId: G.connectionsTabId, windowId: G.connectionsWindowId };
    }

    const currentWindow = await chrome.windows.getCurrent({ windowTypes: ['normal'] });
    const tab = await chrome.tabs.create({
      url:      LINKEDIN_CONNECTIONS_URL,
      active:   false,
      windowId: currentWindow?.id ?? undefined
    });
    G.connectionsTabId    = tab.id;
    G.connectionsWindowId = tab.windowId;
    console.log(`[CRM BG] Created connections tab. Window: ${G.connectionsWindowId}`);
    return { tabId: G.connectionsTabId, windowId: G.connectionsWindowId };

  } catch (err) {
    console.error('[CRM BG] getOrCreateConnectionsTab:', err);
    return { tabId: null, windowId: chrome.windows.WINDOW_ID_NONE };
  }
}

async function ensureDashboardTabActive() {
  try {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PATH);
    const found   = await chrome.tabs.query({ url: pageUrl + '*' });
    if (found.length > 0) {
      const dups = found.slice(1).map(t => t.id).filter(Boolean);
      if (dups.length) await chrome.tabs.remove(dups);
      if (found[0].windowId !== chrome.windows.WINDOW_ID_NONE)
        await chrome.windows.update(found[0].windowId, { focused: true });
      await chrome.tabs.update(found[0].id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (err) {
    console.error('[CRM BG] ensureDashboardTabActive:', err);
  }
}

// ── Profile scraping ───────────────────────────────────────────────────────

function scrapeOneProfile(profileUrl) {
  return new Promise(async (resolve) => {
    // Проверка stop ПЕРЕД открытием вкладки
    if (G.isStopped) {
      console.log('[CRM BG] ⛔ isStopped — skipping profile');
      resolve(null);
      return;
    }

    // ПРАВКА 2: Проверяем connections tab перед каждым профилем
    const canGo = await canContinuePipeline();
    if (!canGo) {
      console.log('[CRM BG] ⛔ canContinuePipeline=false — skipping profile');
      resolve(null);
      return;
    }

    let tabId             = null;
    let messageListener   = null;
    let tabUpdateListener = null;
    let giveUpTimer       = null;

    // Таймаут: 3с инициализация + 5×600мс скролл + запас = 25 сек
    giveUpTimer = setTimeout(() => {
      console.warn('[CRM BG] Timeout profile:', profileUrl);
      cleanup(null);
    }, 25000);

    async function restoreZoom() {
      try {
        if (tabId) {
          await chrome.tabs.setZoom(tabId, 1.0);
          console.log('[CRM BG] Zoom restored to 100%');
        }
      } catch (e) { /* ignore */ }
    }

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);

      if (tabId) {
        // Restore zoom before closing tab
        restoreZoom().finally(() => {
          chrome.tabs.remove(tabId).catch(() => {});
          if (G.activeProfileTabId === tabId) G.activeProfileTabId = null;
          // Возвращаем фокус на connections
          if (G.connectionsTabId) {
            chrome.tabs.update(G.connectionsTabId, { active: true }).catch(() => {});
          }
        });
      }
      resolve(result);
    }

    messageListener = (msg) => {
      if (msg.type === 'PROFILE_DATA') {
        try {
          const profilePath = new URL(profileUrl).pathname;
          const msgPath     = msg.url ? new URL(msg.url).pathname : '';
          if (msgPath.startsWith(profilePath)) {
            console.log('[CRM BG] Profile parsed:', msg.data);
            cleanup(msg.data || null);
          }
        } catch { cleanup(msg.data || null); }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    try {
      // SINGLETON: закрываем предыдущую вкладку профиля
      if (G.activeProfileTabId !== null) {
        console.warn('[CRM BG] Previous profile tab still open — closing:', G.activeProfileTabId);
        try { await chrome.tabs.remove(G.activeProfileTabId); } catch { /* уже закрыта */ }
        G.activeProfileTabId = null;
      }

      // Проверяем что окно connections ещё живо
      if (G.connectionsWindowId !== chrome.windows.WINDOW_ID_NONE) {
        try { await chrome.windows.get(G.connectionsWindowId); }
        catch {
          console.warn('[CRM BG] Connections window closed — recreating');
          await getOrCreateConnectionsTab();
        }
      }

      const targetWindowId = G.connectionsWindowId !== chrome.windows.WINDOW_ID_NONE
        ? G.connectionsWindowId
        : undefined;

      console.log(`[CRM BG] Opening profile in window ${targetWindowId}: ${profileUrl}`);

      // active:true — ОБЯЗАТЕЛЬНО для scroll (LinkedIn требует видимости вкладки)
      const tab = await chrome.tabs.create({
        url:      profileUrl,
        active:   true,
        windowId: targetWindowId
      });

      tabId                = tab.id;
      G.activeProfileTabId = tab.id;

      tabUpdateListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
        tabUpdateListener = null;

        if (G.isStopped) { cleanup(null); return; }

        // Небольшая пауза — SPA LinkedIn начинает инициализацию
        await delay(800);
        if (G.isStopped) { cleanup(null); return; }

        try {
          console.log('[CRM BG] Triggering content load (zoom-out + light scroll)');

          // 1) Initial load wait
          await delay(2000);

          // 2) Step-by-step browser zoom-out (like Ctrl+minus multiple times)
          await chrome.tabs.setZoom(tabId, 0.8);
          console.log('[CRM BG] Zoom step 1: 80%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.67);
          console.log('[CRM BG] Zoom step 2: 67%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.33);
          console.log('[CRM BG] Zoom: 33% (max zoom-out)');

          await chrome.tabs.setZoom(tabId, 0.25);
          console.log('[CRM BG] Zoom: 25% (max zoom-out)');
          // 3) Wait for DOM re-render after zoom
          await delay(1000);

          // 4) Scroll to bottom using scrollingElement (works correctly with zoom)
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const scrollingEl = document.scrollingElement || document.documentElement;
              // First scroll attempt
              scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
              // Force reflow and second scroll (for zoomed pages)
              void document.body.offsetHeight;
              scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
            }
          });

          // 5) Wait 2 seconds after scroll before parsing
          await delay(2000);

          await chrome.scripting.executeScript({ target: { tabId }, files: ['profile_scraper.js'] });
          console.log('[CRM BG] profile_scraper.js injected');

        } catch (err) {
          console.warn('[CRM BG] Injection failed:', err.message);
          cleanup(null);
        }
      };

      chrome.tabs.onUpdated.addListener(tabUpdateListener);

    } catch (err) {
      console.error('[CRM BG] Could not open profile tab:', err);
      cleanup(null);
    }
  });
}

/**
 * scrapeOneProfileForEnrich — отдельный pipeline для Data таба
 * Особенности:
 *   - zoom-out + лёгкий scroll (вместо heavy scroll loops)
 *   - zoom восстанавливается после обработки
 */
function scrapeOneProfileForEnrich(profileUrl) {
  return new Promise(async (resolve) => {
    let tabId             = null;
    let messageListener   = null;
    let tabUpdateListener = null;
    let giveUpTimer       = null;

    // Таймаут: 2с load + 1с zoom reflow + запас = 25 сек
    giveUpTimer = setTimeout(() => {
      console.warn('[CRM BG] Timeout enrich profile:', profileUrl);
      cleanup({ jobTitle: '', company: '', school: '', major: '', location: '' });
    }, 25000);

    async function restoreZoom() {
      try {
        if (tabId) {
          await chrome.tabs.setZoom(tabId, 1.0);
          console.log('[CRM BG] Enrich: Zoom restored to 100%');
        }
      } catch (e) { /* ignore */ }
    }

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);

      if (tabId) {
        // Restore zoom before closing tab
        restoreZoom().finally(() => {
          chrome.tabs.remove(tabId).catch(() => {});
        });
      }
      resolve(result);
    }

    messageListener = (msg) => {
      if (msg.type === 'PROFILE_DATA') {
        try {
          const profilePath = new URL(profileUrl).pathname;
          const msgPath     = msg.url ? new URL(msg.url).pathname : '';
          if (msgPath.startsWith(profilePath)) {
            console.log('[CRM BG] Enrich profile parsed:', msg.data);
            cleanup(msg.data || { jobTitle: '', company: '', school: '', major: '', location: '' });
          }
        } catch {
          cleanup(msg.data || { jobTitle: '', company: '', school: '', major: '', location: '' });
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    try {
      const tab = await chrome.tabs.create({ url: profileUrl, active: true });
      tabId = tab.id;

      tabUpdateListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
        tabUpdateListener = null;

        try {
          console.log('[CRM BG] Enrich: Triggering content load (zoom-out + light scroll)');

          // 1) Initial load wait
          await delay(2000);

          // 2) Step-by-step browser zoom-out (like Ctrl+minus multiple times)
          await chrome.tabs.setZoom(tabId, 0.8);
          console.log('[CRM BG] Enrich: Zoom step 1: 80%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.67);
          console.log('[CRM BG] Enrich: Zoom step 2: 67%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.33);
          console.log('[CRM BG] Enrich: Zoom: 33% (max zoom-out)');
          await chrome.tabs.setZoom(tabId, 0.25);
          console.log('[CRM BG] Enrich: Zoom: 25% (max zoom-out)');
          // 3) Wait for DOM re-render after zoom
          await delay(1000);

          // 4) Scroll to bottom using scrollingElement (works correctly with zoom)
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const scrollingEl = document.scrollingElement || document.documentElement;
              // First scroll attempt
              scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
              // Force reflow and second scroll (for zoomed pages)
              void document.body.offsetHeight;
              scrollingEl.scrollTop = scrollingEl.scrollHeight * 10;
            }
          });

          // 5) Wait 2 seconds after scroll before parsing
          await delay(2000);

          await chrome.scripting.executeScript({ target: { tabId }, files: ['profile_scraper.js'] });
          console.log('[CRM BG] Enrich: profile_scraper.js injected');

        } catch (err) {
          console.warn('[CRM BG] Enrich: Injection failed:', err.message);
          cleanup({ jobTitle: '', company: '', school: '', major: '', location: '' });
        }
      };

      chrome.tabs.onUpdated.addListener(tabUpdateListener);

    } catch (err) {
      console.error('[CRM BG] Enrich: Could not open profile tab:', err);
      cleanup({ jobTitle: '', company: '', school: '', major: '', location: '' });
    }
  });
}

/**
 * Обогащает контакты. Строго последовательно — ОДИН профиль за раз.
 * ПРАВКА 2: canContinuePipeline() теперь вызывается и здесь (дополнительная проверка).
 */
async function enrichContacts(contacts, pauseMs) {
  if (G.isRunning) {
    console.warn('[CRM BG] enrichContacts: already running — BLOCKED');
    return contacts;
  }

  G.isRunning = true;
  G.isStopped = false;
  const enriched = [];

  try {
    for (let i = 0; i < contacts.length; i++) {
      // Kill switch
      if (G.isStopped) {
        console.log(`[CRM BG] ⛔ Pipeline stopped at ${i}/${contacts.length}`);
        for (let j = i; j < contacts.length; j++) {
          enriched.push({ ...contacts[j], jobTitle: '', company: '', school: '', major: '', location: '' });
        }
        break;
      }

      // ПРАВКА 2: проверяем connections tab перед каждым профилем
      const canGo = await canContinuePipeline();
      if (!canGo) {
        console.log(`[CRM BG] ⛔ Pipeline check failed at ${i}/${contacts.length} — stopping`);
        for (let j = i; j < contacts.length; j++) {
          enriched.push({ ...contacts[j], jobTitle: '', company: '', school: '', major: '', location: '' });
        }
        break;
      }

      // Также проверяем через storage (для cross-process stop)
      const snap = await getStorage(['crm_sync_command']);
      if (snap.crm_sync_command === 'stop' || G.isStopped) {
        console.log(`[CRM BG] ⛔ Stop command at ${i}/${contacts.length}`);
        for (let j = i; j < contacts.length; j++) {
          enriched.push({ ...contacts[j], jobTitle: '', company: '', school: '', major: '', location: '' });
        }
        break;
      }

      const contact = contacts[i];

      // Resume-safe: пропускаем уже обработанные
      if (contact.jobTitle || contact.company || contact.school) {
        enriched.push(contact);
        continue;
      }

      console.log(`[CRM BG] Profile ${i + 1}/${contacts.length}: ${contact.profileUrl}`);
      const data = await scrapeOneProfile(contact.profileUrl);

      if (G.isStopped) {
        enriched.push({ ...contact, jobTitle: data?.jobTitle || '', company: data?.company || '', school: data?.school || '', major: data?.major || '', location: data?.location || '' });
        for (let j = i + 1; j < contacts.length; j++) {
          enriched.push({ ...contacts[j], jobTitle: '', company: '', school: '', major: '', location: '' });
        }
        break;
      }

      enriched.push({
        ...contact,
        jobTitle: data?.jobTitle || '',
        company:  data?.company  || '',
        school:   data?.school   || '',
        major:    data?.major    || '',
        location: data?.location || ''
      });

      if (i < contacts.length - 1 && !G.isStopped) {
        const pause = (pauseMs || 700) + Math.random() * 300;
        await delay(pause);
      }
    }
  } finally {
    G.isRunning = false;
    G.isStopped = false;
  }

  return enriched;
}

// ── Обработчик сообщений ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ENSURE_CONTENT_SCRIPT
  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const { tabId, windowId } = await getOrCreateConnectionsTab();
        if (!tabId) { sendResponse({ ok: false, reason: 'could_not_open_tab' }); return; }

        // Make sure the user sees the Connections list during sync
        try {
          if (windowId !== chrome.windows.WINDOW_ID_NONE) {
            await chrome.windows.update(windowId, { focused: true });
          }
          await chrome.tabs.update(tabId, { active: true });
        } catch (e) {
          console.warn('[CRM BG] Could not focus connections tab:', e);
        }

        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length === 0) {
          await delay(3500);
          sendResponse({ ok: true, created: true, windowId });
          return;
        }

        try {
          const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (pong?.alive) { sendResponse({ ok: true, alive: true, windowId }); return; }
        } catch { /* инжектируем */ }

        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        sendResponse({ ok: true, injected: true, windowId });
      } catch (err) {
        console.error('[CRM BG] ENSURE_CONTENT_SCRIPT:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // ENRICH_CONTACTS
  if (msg.type === 'ENRICH_CONTACTS') {
    const { contacts, pauseMs = 700 } = msg;
    if (!contacts?.length) { sendResponse({ ok: true, enriched: [] }); return true; }

    if (G.isRunning) {
      console.warn('[CRM BG] ENRICH_CONTACTS: pipeline already running — rejected');
      sendResponse({ ok: false, reason: 'already_running', enriched: contacts });
      return true;
    }

    enrichContacts(contacts, pauseMs)
      .then(enriched => sendResponse({ ok: true, enriched }))
      .catch(err => {
        console.error('[CRM BG] ENRICH_CONTACTS error:', err);
        G.isRunning = false;
        sendResponse({ ok: false, enriched: contacts });
      });
    return true;
  }

  // ENRICH_OPEN_PROFILE — отдельный pipeline для Data таба
  if (msg.type === 'ENRICH_OPEN_PROFILE') {
    (async () => {
      const { profileUrl } = msg;
      if (!profileUrl) { sendResponse({ ok: false, reason: 'no_url' }); return; }

      // Singleton: не запускаем если уже идёт основной sync
      if (G.isRunning) {
        console.warn('[CRM BG] ENRICH_OPEN_PROFILE: sync pipeline running — rejected');
        sendResponse({ ok: false, reason: 'sync_running' });
        return;
      }

      try {
        const data = await scrapeOneProfileForEnrich(profileUrl);
        sendResponse({ ok: true, data });
      } catch (err) {
        console.error('[CRM BG] ENRICH_OPEN_PROFILE error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // STOP_PIPELINE
  if (msg.type === 'STOP_PIPELINE') {
    void killPipeline('STOP_PIPELINE message');
    sendResponse({ ok: true });
    return true;
  }

  // RESTART_SYNC
  if (msg.type === 'RESTART_SYNC') {
    (async () => {
      try {
        await killPipeline('RESTART_SYNC');

        await chrome.storage.local.set({
          crm_contacts:         [],
          crm_sync_count:       0,
          crm_sync_total:       null,
          crm_sync_percent:     0,
          crm_sync_label:       '',
          crm_sync_eta_seconds: null,
          crm_sync_status:      'idle',
          crm_sync_phase:       '',
          crm_sync_command:     null,
          crm_heartbeat:        0
        });

        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length > 0) {
          const dups = tabs.slice(1).map(t => t.id).filter(Boolean);
          if (dups.length) await chrome.tabs.remove(dups);
          await chrome.tabs.reload(tabs[0].id);
          G.connectionsTabId    = tabs[0].id;
          G.connectionsWindowId = tabs[0].windowId;
        } else {
          await getOrCreateConnectionsTab();
        }

        G.isStopped = false;
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[CRM BG] RESTART_SYNC:', err);
        G.isStopped = false;
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // CONTENT_READY — НЕ автозапускаем
  if (msg.type === 'CONTENT_READY') {
    console.log('[CRM BG] content.js ready, tab:', sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }

});

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureDashboardTabActive();
    await getOrCreateConnectionsTab();
  })();
});

chrome.runtime.onSuspend.addListener(() => {
  console.log('[CRM BG] SW suspending — killing pipeline');
  void killPipeline('onSuspend');
});

void (async () => {
  const data = await getStorage(['crm_sync_status']);
  if (data.crm_sync_status === 'running') {
    console.log('[CRM BG] SW reboot: resetting stale running status');
    await chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
  }
  const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
  if (existing.length > 0) {
    G.connectionsTabId    = existing[0].id;
    G.connectionsWindowId = existing[0].windowId;
    console.log(`[CRM BG] Restored windowId: ${G.connectionsWindowId}`);
  }
})().catch(() => {});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['crm_sync_status'], data => {
    if (data.crm_sync_status === 'running') {
      chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
    }
  });
  G.isRunning  = false;
  G.isStopped  = false;
  G.activeProfileTabId = null;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CRM BG] Extension installed/updated v2.5');
});