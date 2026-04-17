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
const DASHBOARD_PATH = 'dashboard.html';

// ── ГЛОБАЛЬНЫЙ SINGLETON STATE ────────────────────────────────────────────

const G = {
  isRunning:           false,
  isStopped:           false,
  activeProfileTabId:  null,
  connectionsTabId:    null,
  connectionsWindowId: chrome.windows.WINDOW_ID_NONE
};

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

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);

      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
        if (G.activeProfileTabId === tabId) G.activeProfileTabId = null;
        // Возвращаем фокус на connections
        if (G.connectionsTabId) {
          chrome.tabs.update(G.connectionsTabId, { active: true }).catch(() => {});
        }
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

          await chrome.tabs.setZoom(tabId, 0.5);
          console.log('[CRM BG] Zoom step 3: 50%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.33);
          console.log('[CRM BG] Zoom step 4: 33% (max zoom-out)');

          // 3) Wait for DOM re-render after zoom
          await delay(1000);

          // 4) Light scroll to trigger lazy rendering
          await chrome.scripting.executeScript({
            target: { tabId },
            func: async () => {
              window.scrollBy(0, Math.round(window.innerHeight * 0.8));
              await new Promise(r => setTimeout(r, 600));
            }
          });

          if (G.isStopped) { cleanup(null); return; }

          // ── Инжектируем profile_scraper.js для парсинга ────────────────
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

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);

      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
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

          await chrome.tabs.setZoom(tabId, 0.5);
          console.log('[CRM BG] Enrich: Zoom step 3: 50%');
          await delay(100);

          await chrome.tabs.setZoom(tabId, 0.33);
          console.log('[CRM BG] Enrich: Zoom step 4: 33% (max zoom-out)');

          // 3) Wait for DOM re-render after zoom
          await delay(1000);

          // 4) Light scroll to trigger lazy rendering
          await chrome.scripting.executeScript({
            target: { tabId },
            func: async () => {
              window.scrollBy(0, Math.round(window.innerHeight * 0.8));
              await new Promise(r => setTimeout(r, 600));
            }
          });

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