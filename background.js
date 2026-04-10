/**
 * background.js — LinkedIn CRM v2.5
 * (unchanged from v2.5 — pipeline is stable)
 */
const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const DASHBOARD_PATH = 'dashboard.html';

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
    try { await chrome.tabs.remove(G.activeProfileTabId); } catch { }
    G.activeProfileTabId = null;
  }
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function canContinuePipeline() {
  if (G.isStopped) return false;
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
    return false;
  }
}

async function getOrCreateConnectionsTab() {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
    if (existing.length > 1) {
      const dups = existing.slice(1).map(t => t.id).filter(Boolean);
      await chrome.tabs.remove(dups);
    }
    if (existing.length >= 1) {
      G.connectionsTabId    = existing[0].id;
      G.connectionsWindowId = existing[0].windowId;
      return { tabId: G.connectionsTabId, windowId: G.connectionsWindowId };
    }
    const currentWindow = await chrome.windows.getCurrent({ windowTypes: ['normal'] });
    const tab = await chrome.tabs.create({
      url: LINKEDIN_CONNECTIONS_URL, active: false,
      windowId: currentWindow?.id ?? undefined
    });
    G.connectionsTabId    = tab.id;
    G.connectionsWindowId = tab.windowId;
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

function scrapeOneProfile(profileUrl) {
  return new Promise(async (resolve) => {
    if (G.isStopped) { resolve(null); return; }
    const canGo = await canContinuePipeline();
    if (!canGo) { resolve(null); return; }

    let tabId = null, messageListener = null, tabUpdateListener = null, giveUpTimer = null;

    giveUpTimer = setTimeout(() => {
      console.warn('[CRM BG] Timeout profile:', profileUrl);
      cleanup(null);
    }, 35000);

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
        if (G.activeProfileTabId === tabId) G.activeProfileTabId = null;
        if (G.connectionsTabId) chrome.tabs.update(G.connectionsTabId, { active: true }).catch(() => {});
      }
      resolve(result);
    }

    messageListener = (msg) => {
      if (msg.type === 'PROFILE_DATA') {
        try {
          const profilePath = new URL(profileUrl).pathname;
          const msgPath     = msg.url ? new URL(msg.url).pathname : '';
          if (msgPath.startsWith(profilePath)) cleanup(msg.data || null);
        } catch { cleanup(msg.data || null); }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    try {
      if (G.activeProfileTabId !== null) {
        try { await chrome.tabs.remove(G.activeProfileTabId); } catch { }
        G.activeProfileTabId = null;
      }
      if (G.connectionsWindowId !== chrome.windows.WINDOW_ID_NONE) {
        try { await chrome.windows.get(G.connectionsWindowId); }
        catch { await getOrCreateConnectionsTab(); }
      }

      const targetWindowId = G.connectionsWindowId !== chrome.windows.WINDOW_ID_NONE
        ? G.connectionsWindowId : undefined;

      const tab = await chrome.tabs.create({ url: profileUrl, active: true, windowId: targetWindowId });
      tabId = tab.id;
      G.activeProfileTabId = tab.id;

      tabUpdateListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
        tabUpdateListener = null;
        if (G.isStopped) { cleanup(null); return; }
        await delay(800);
        if (G.isStopped) { cleanup(null); return; }
        try {
          // Fixed 5×600ms scroll
          await chrome.scripting.executeScript({
            target: { tabId },
            func: async () => {
              await new Promise(r => setTimeout(r, 3000));
              for (let i = 0; i < 5; i++) {
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 600));
                console.log(`[CRM Scraper] Scroll ${i+1}/5`);
              }
            }
          });
          if (G.isStopped) { cleanup(null); return; }
          await chrome.scripting.executeScript({ target: { tabId }, files: ['profile_scraper.js'] });
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
      if (G.isStopped) {
        for (let j = i; j < contacts.length; j++) enriched.push(contacts[j]);
        break;
      }
      const canGo = await canContinuePipeline();
      if (!canGo) {
        for (let j = i; j < contacts.length; j++) enriched.push(contacts[j]);
        break;
      }
      const snap = await getStorage(['crm_sync_command']);
      if (snap.crm_sync_command === 'stop' || G.isStopped) {
        for (let j = i; j < contacts.length; j++) enriched.push(contacts[j]);
        break;
      }
      const contact = contacts[i];
      if (contact.jobTitle || contact.company || contact.school) {
        enriched.push(contact); continue;
      }
      console.log(`[CRM BG] Profile ${i+1}/${contacts.length}: ${contact.profileUrl}`);
      const data = await scrapeOneProfile(contact.profileUrl);
      if (G.isStopped) {
        enriched.push({ ...contact, jobTitle: data?.jobTitle||'', company: data?.company||'', school: data?.school||'', major: data?.major||'' });
        for (let j = i+1; j < contacts.length; j++) enriched.push(contacts[j]);
        break;
      }
      enriched.push({ ...contact, jobTitle: data?.jobTitle||'', company: data?.company||'', school: data?.school||'', major: data?.major||'' });
      if (i < contacts.length - 1 && !G.isStopped) {
        await delay((pauseMs||700) + Math.random()*300);
      }
    }
  } finally {
    G.isRunning = false;
    G.isStopped = false;
  }
  return enriched;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const { tabId, windowId } = await getOrCreateConnectionsTab();
        if (!tabId) { sendResponse({ ok: false, reason: 'could_not_open_tab' }); return; }
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length === 0) { await delay(3500); sendResponse({ ok: true, created: true, windowId }); return; }
        try {
          const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (pong?.alive) { sendResponse({ ok: true, alive: true, windowId }); return; }
        } catch { }
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        sendResponse({ ok: true, injected: true, windowId });
      } catch (err) {
        console.error('[CRM BG] ENSURE_CONTENT_SCRIPT:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'ENRICH_CONTACTS') {
    const { contacts, pauseMs = 700 } = msg;
    if (!contacts?.length) { sendResponse({ ok: true, enriched: [] }); return true; }
    if (G.isRunning) {
      sendResponse({ ok: false, reason: 'already_running', enriched: contacts });
      return true;
    }
    enrichContacts(contacts, pauseMs)
      .then(enriched => sendResponse({ ok: true, enriched }))
      .catch(err => { G.isRunning = false; sendResponse({ ok: false, enriched: contacts }); });
    return true;
  }

  if (msg.type === 'STOP_PIPELINE') {
    void killPipeline('STOP_PIPELINE message');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RESTART_SYNC') {
    (async () => {
      try {
        await killPipeline('RESTART_SYNC');
        await chrome.storage.local.set({
          crm_contacts: [], crm_sync_count: 0, crm_sync_total: null,
          crm_sync_percent: 0, crm_sync_label: '', crm_sync_eta_seconds: null,
          crm_sync_status: 'idle', crm_sync_phase: '', crm_sync_command: null, crm_heartbeat: 0
        });
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length > 0) {
          const dups = tabs.slice(1).map(t => t.id).filter(Boolean);
          if (dups.length) await chrome.tabs.remove(dups);
          await chrome.tabs.reload(tabs[0].id);
          G.connectionsTabId = tabs[0].id;
          G.connectionsWindowId = tabs[0].windowId;
        } else { await getOrCreateConnectionsTab(); }
        G.isStopped = false;
        sendResponse({ ok: true });
      } catch (err) {
        G.isStopped = false;
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CONTENT_READY') {
    sendResponse({ ok: true });
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureDashboardTabActive();
    await getOrCreateConnectionsTab();
  })();
});

chrome.runtime.onSuspend.addListener(() => {
  void killPipeline('onSuspend');
});

void (async () => {
  const data = await getStorage(['crm_sync_status']);
  if (data.crm_sync_status === 'running')
    await chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
  const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
  if (existing.length > 0) {
    G.connectionsTabId    = existing[0].id;
    G.connectionsWindowId = existing[0].windowId;
  }
})().catch(() => {});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['crm_sync_status'], data => {
    if (data.crm_sync_status === 'running')
      chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
  });
  G.isRunning = false; G.isStopped = false; G.activeProfileTabId = null;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CRM BG] Extension installed/updated v3.0');
});