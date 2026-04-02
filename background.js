const LINKEDIN_CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LINKEDIN_CONNECTIONS_PATTERNS = [
  "https://www.linkedin.com/mynetwork/invite-connect/connections/*",
  "https://www.linkedin.com/mynetwork/invite-connect/connections/"
];

// Ключ session storage: уведомление не чаще одного раза за «сессию» (пока браузер открыт и расширение не отключали).
const ACTIVATION_TOAST_SESSION_KEY = "linkedinCrmActivationToastV1";

/**
 * Гарантирует, что существует только одна вкладка LinkedIn Connections.
 *
 * Важно: не переключаем фокус на вкладку при автозапуске браузера:
 * - если вкладка уже есть, ничего не активируем
 * - если вкладки нет, создаем как неактивную (`active: false`)
 */
async function ensureConnectionsTab(trigger) {
  try {
    const existingTabs = await chrome.tabs.query({
      url: LINKEDIN_CONNECTIONS_PATTERNS
    });

    if (existingTabs.length > 0) {
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

    // Если нужной вкладки нет — создаем новую в фоне.
    // `active: false` должен предотвращать переключение фокуса браузера.
    const createdTab = await chrome.tabs.create({
      url: LINKEDIN_CONNECTIONS_URL,
      active: false
    });

    // На случай гонки между `onStartup` и `onInstalled` повторно проверяем наличие.
    // Оставляем только что созданную вкладку.
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
    console.error(`[LinkedIn CRM Bootstrap] ${trigger} failed:`, error);
  }
}

/**
 * Одно нативное уведомление ОС за сессию (см. ACTIVATION_TOAST_SESSION_KEY).
 * chrome.storage.session очищается при закрытии браузера и при отключении расширения —
 * после включения переключателем в chrome://extensions снова покажем тост.
 */
async function showActivationNotificationOncePerSession() {
  try {
    const snapshot = await chrome.storage.session.get(ACTIVATION_TOAST_SESSION_KEY);
    if (snapshot[ACTIVATION_TOAST_SESSION_KEY]) {
      return;
    }

    await chrome.storage.session.set({ [ACTIVATION_TOAST_SESSION_KEY]: true });

    await chrome.notifications.create(`linkedin-crm-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "LinkedIn CRM",
      message: "Расширение активно.",
      contextMessage: "Системные уведомления Chrome должны быть разрешены.",
      priority: 2
    });
  } catch (error) {
    console.error("[LinkedIn CRM Bootstrap] notification failed:", error);
  }
}

/**
 * Холодный старт service worker: срабатывает при reload расширения и при включении
 * после отключения в chrome://extensions. В этих случаях часто НЕ приходят
 * `onInstalled` и `onStartup`, поэтому отдельно от слушателей запускаем инициализацию здесь.
 */
async function bootServiceWorker() {
  await ensureConnectionsTab("service_worker_boot");
  await showActivationNotificationOncePerSession();
}

chrome.runtime.onStartup.addListener(() => {
  void ensureConnectionsTab("onStartup");
});

// Полезно для первого запуска после установки/обновления расширения.
chrome.runtime.onInstalled.addListener(() => {
  void ensureConnectionsTab("onInstalled");
});

void bootServiceWorker();
