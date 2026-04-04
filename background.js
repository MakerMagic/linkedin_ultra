/**
 * background.js — LinkedIn CRM v0.5
 *
 * Главное изменение:
 *   При получении CONTENT_READY → автоматически ставим команду 'start'.
 *   Пользователю не нужно нажимать кнопку — синхронизация начинается сама.
 */

const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const DASHBOARD_PATH = 'dashboard.html';

// ─── Управление вкладками ──────────────────────────────────────────────────

async function ensureConnectionsTab() {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
    if (existing.length > 0) {
      const dups = existing.slice(1).map(t => t.id).filter(Boolean);
      if (dups.length) await chrome.tabs.remove(dups);
      return existing[0].id;
    }
    const tab = await chrome.tabs.create({ url: LINKEDIN_CONNECTIONS_URL, active: false });
    return tab.id;
  } catch (err) {
    console.error('[CRM BG] ensureConnectionsTab:', err);
    return null;
  }
}

async function ensureDashboardTabActive() {
  try {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PATH);
    const found   = await chrome.tabs.query({ url: pageUrl + '*' });
    if (found.length > 0) {
      const dups = found.slice(1).map(t => t.id).filter(Boolean);
      if (dups.length) await chrome.tabs.remove(dups);
      const tab = found[0];
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      if (tab.id)       await chrome.tabs.update(tab.id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (err) {
    console.error('[CRM BG] ensureDashboardTabActive:', err);
  }
}

// ─── Обработчик сообщений ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  /**
   * CONTENT_READY: content.js загрузился на LinkedIn.
   * Автоматически запускаем синхронизацию — пишем команду в storage.
   * content.js слушает storage.onChanged и начинает runSync().
   */
  if (msg.type === 'CONTENT_READY') {
    console.log('[CRM BG] CONTENT_READY от tab', sender.tab?.id);

    // Проверяем: не идёт ли синхронизация уже
    chrome.storage.local.get(['crm_sync_status', 'crm_sync_command'], data => {
      const alreadyRunning =
        data.crm_sync_status  === 'running' ||
        data.crm_sync_command === 'start';

      if (!alreadyRunning) {
        console.log('[CRM BG] Автозапуск синхронизации');
        chrome.storage.local.set({
          crm_sync_command: 'start',
          crm_sync_status:  'running'
        });
      } else {
        console.log('[CRM BG] Синхронизация уже идёт или запущена');
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  /**
   * ENSURE_CONTENT_SCRIPT: Dashboard запрашивает проверку/инжекцию content.js.
   * Используется кнопкой «Начать» как fallback.
   */
  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });

        if (tabs.length === 0) {
          const tabId = await ensureConnectionsTab();
          if (!tabId) {
            sendResponse({ ok: false, reason: 'could_not_open_tab' });
            return;
          }
          // Ждём загрузки страницы
          await new Promise(r => setTimeout(r, 3500));
          sendResponse({ ok: true, created: true });
          return;
        }

        const tabId = tabs[0].id;

        // Пингуем content.js
        try {
          const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (pong?.alive) {
            sendResponse({ ok: true, alive: true });
            return;
          }
        } catch { /* не ответил — инжектируем */ }

        // Программный инжект (fallback для SPA-навигации)
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        sendResponse({ ok: true, injected: true });

      } catch (err) {
        console.error('[CRM BG] ENSURE_CONTENT_SCRIPT:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

// Клик по иконке → открываем LinkedIn + dashboard
chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureConnectionsTab();
    await ensureDashboardTabActive();
  })();
});

// При старте SW сбрасываем зависший running статус
chrome.storage.local.get(['crm_sync_status'], data => {
  if (data.crm_sync_status === 'running') {
    // SW перезапустился — content.js уже мёртв, сбрасываем
    chrome.storage.local.set({
      crm_sync_status:  'idle',
      crm_sync_command: null
    });
  }
});

void ensureConnectionsTab().catch(() => {});
chrome.runtime.onStartup.addListener(() => void ensureConnectionsTab().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => void ensureConnectionsTab().catch(() => {}));