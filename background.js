const LINKEDIN_CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LINKEDIN_CONNECTIONS_PATTERNS = [
  "https://www.linkedin.com/mynetwork/invite-connect/connections/*",
  "https://www.linkedin.com/mynetwork/invite-connect/connections/"
];

const DASHBOARD_PATH = "dashboard.html";

/**
 * Одна вкладка LinkedIn Connections, без активации (фон).
 */
async function ensureConnectionsTab(trigger) {
  try {
    const existingTabs = await chrome.tabs.query({
      url: LINKEDIN_CONNECTIONS_PATTERNS
    });

    if (existingTabs.length > 0) {
      const duplicateTabIds = existingTabs
        .slice(1)
        .map((tab) => tab.id)
        .filter((id) => typeof id === "number");

      if (duplicateTabIds.length > 0) {
        await chrome.tabs.remove(duplicateTabIds);
      }
      return;
    }

    const createdTab = await chrome.tabs.create({
      url: LINKEDIN_CONNECTIONS_URL,
      active: false
    });

    const tabsAfterCreate = await chrome.tabs.query({
      url: LINKEDIN_CONNECTIONS_PATTERNS
    });

    if (tabsAfterCreate.length > 1 && typeof createdTab?.id === "number") {
      const toRemove = tabsAfterCreate
        .filter((t) => t.id !== createdTab.id)
        .map((t) => t.id)
        .filter((id) => typeof id === "number");

      if (toRemove.length > 0) {
        await chrome.tabs.remove(toRemove);
      }
    }
  } catch (error) {
    console.error(`[LinkedIn CRM] ${trigger} (connections) failed:`, error);
  }
}

/**
 * Одна вкладка UI; окно в фокусе, вкладка активна.
 */
async function ensureDashboardTabActive(trigger) {
  try {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PATH);
    const found = await chrome.tabs.query({ url: pageUrl + "*" });

    if (found.length > 0) {
      const primary = found[0];
      const duplicateIds = found
        .slice(1)
        .map((t) => t.id)
        .filter((id) => typeof id === "number");

      if (duplicateIds.length > 0) {
        await chrome.tabs.remove(duplicateIds);
      }

      if (primary.windowId !== chrome.windows.WINDOW_ID_NONE) {
        await chrome.windows.update(primary.windowId, { focused: true });
      }
      if (typeof primary.id === "number") {
        await chrome.tabs.update(primary.id, { active: true });
      }
      return;
    }

    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (error) {
    console.error(`[LinkedIn CRM] ${trigger} (dashboard) failed:`, error);
  }
}

// Без default_popup — срабатывает клик по иконке.
chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureConnectionsTab("action_click");
    await ensureDashboardTabActive("action_click");
  })();
});

// После включения в chrome://extensions часто нет onInstalled/onStartup — только Connections, без UI.
void (async () => {
  await ensureConnectionsTab("service_worker_boot");
})();

chrome.runtime.onStartup.addListener(() => {
  void ensureConnectionsTab("onStartup");
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureConnectionsTab("onInstalled");
});
