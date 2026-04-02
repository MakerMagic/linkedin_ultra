const LINKEDIN_CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LINKEDIN_CONNECTIONS_PATTERNS = [
  "https://www.linkedin.com/mynetwork/invite-connect/connections/*",
  "https://www.linkedin.com/mynetwork/invite-connect/connections/"
];

/**
 * Гарантирует, что существует только одна вкладка LinkedIn Connections:
 * если вкладка уже открыта — просто фокусируем ее, если нет — создаем новую.
 */
async function ensureConnectionsTab(trigger) {
  try {
    const existingTabs = await chrome.tabs.query({
      url: LINKEDIN_CONNECTIONS_PATTERNS
    });

    if (existingTabs.length > 0) {
      const primaryTab = existingTabs[0];

      // Переключаем пользователя на найденную вкладку.
      if (primaryTab.windowId !== chrome.windows.WINDOW_ID_NONE) {
        await chrome.windows.update(primaryTab.windowId, { focused: true });
      }

      if (typeof primaryTab.id === "number") {
        await chrome.tabs.update(primaryTab.id, { active: true });
      }

      // Удаляем возможные дубликаты, чтобы не плодить лишние вкладки.
      const duplicateTabIds = existingTabs
        .slice(1)
        .map((tab) => tab.id)
        .filter((id) => typeof id === "number");

      if (duplicateTabIds.length > 0) {
        await chrome.tabs.remove(duplicateTabIds);
      }

      return;
    }

    // Если нужной вкладки нет — создаем новую.
    await chrome.tabs.create({ url: LINKEDIN_CONNECTIONS_URL, active: true });
  } catch (error) {
    // Ошибки логируем для отладки в service worker.
    console.error(`[LinkedIn CRM Bootstrap] ${trigger} failed:`, error);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureConnectionsTab("onStartup");
});

// Полезно для первого запуска после установки/обновления расширения.
chrome.runtime.onInstalled.addListener(() => {
  ensureConnectionsTab("onInstalled");
});
