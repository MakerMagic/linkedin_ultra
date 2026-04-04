/**
 * background.js — Service Worker LinkedIn CRM.
 *
 * Новое в v0.4:
 *   Обрабатывает запрос ENSURE_CONTENT_SCRIPT от Dashboard:
 *   1. Пингует content.js на вкладке LinkedIn
 *   2. Если не отвечает — инжектирует заново через chrome.scripting
 */

const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const DASHBOARD_PATH = 'dashboard.html';

// ——— Управление вкладками ———

async function ensureConnectionsTab(trigger) {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
    if (existing.length > 0) {
      // Оставляем первую, закрываем дубликаты
      const dups = existing.slice(1).map(t => t.id).filter(id => typeof id === 'number');
      if (dups.length) await chrome.tabs.remove(dups);
      return existing[0].id;
    }
    const tab = await chrome.tabs.create({ url: LINKEDIN_CONNECTIONS_URL, active: false });
    return tab.id;
  } catch (err) {
    console.error(`[CRM BG] ${trigger} — ошибка открытия вкладки Connections:`, err);
    return null;
  }
}

async function ensureDashboardTabActive(trigger) {
  try {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PATH);
    const found = await chrome.tabs.query({ url: pageUrl + '*' });
    if (found.length > 0) {
      const primary = found[0];
      const dups = found.slice(1).map(t => t.id).filter(id => typeof id === 'number');
      if (dups.length) await chrome.tabs.remove(dups);
      if (primary.windowId !== chrome.windows.WINDOW_ID_NONE) {
        await chrome.windows.update(primary.windowId, { focused: true });
      }
      if (typeof primary.id === 'number') await chrome.tabs.update(primary.id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (err) {
    console.error(`[CRM BG] ${trigger} — ошибка открытия Dashboard:`, err);
  }
}

// ——— Запросы от Dashboard ———

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  /**
   * ENSURE_CONTENT_SCRIPT:
   * Dashboard вызывает это перед командой START.
   * Гарантирует что content.js жив на вкладке LinkedIn.
   */
  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });

        if (tabs.length === 0) {
          // Вкладки нет — создаём и возвращаем статус
          const tabId = await ensureConnectionsTab('ensure_cs');
          if (!tabId) {
            sendResponse({ ok: false, reason: 'could_not_open_tab' });
            return;
          }
          // Даём вкладке загрузиться (content_scripts авто-инжектится)
          await new Promise(r => setTimeout(r, 3000));
          sendResponse({ ok: true, created: true });
          return;
        }

        const tabId = tabs[0].id;

        // Пингуем content script
        try {
          const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (pong && pong.alive) {
            sendResponse({ ok: true, alive: true });
            return;
          }
        } catch {
          // content.js не ответил — инжектируем вручную
        }

        // Программный инжект (fallback для SPA-навигации)
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });

        sendResponse({ ok: true, injected: true });
      } catch (err) {
        console.error('[CRM BG] ENSURE_CONTENT_SCRIPT ошибка:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true; // async sendResponse
  }

});

// ——— Lifecycle ———

chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureConnectionsTab('action_click');
    await ensureDashboardTabActive('action_click');
  })();
});

void (async () => { await ensureConnectionsTab('service_worker_boot'); })();

chrome.runtime.onStartup.addListener(() => { void ensureConnectionsTab('onStartup'); });
chrome.runtime.onInstalled.addListener(() => { void ensureConnectionsTab('onInstalled'); });