/**
 * background.js — LinkedIn CRM v2.3
 *
 * Строгий контроль вкладок:
 *   - НЕ открываем connections при старте расширения
 *   - ВСЕ профили открываются в том же окне что и connections
 *   - Ровно одна вкладка connections в любой момент
 *   - При Start/Resume/Restart — проверяем и создаём только если нет
 */

const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const DASHBOARD_PATH = 'dashboard.html';

// ── Хранение windowId ─────────────────────────────────────────────────────

/**
 * connectionsWindowId — окно где открыта вкладка LinkedIn Connections.
 * Все вкладки профилей открываются в этом окне.
 * Обновляется при каждом вызове getOrCreateConnectionsTab().
 */
let connectionsWindowId = chrome.windows.WINDOW_ID_NONE;
let connectionsTabId    = null;

// ── Утилиты ───────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

// ── Управление вкладкой connections ──────────────────────────────────────

/**
 * Гарантирует ровно одну вкладку connections:
 *   - Если несколько → закрывает дубликаты, оставляет первую
 *   - Если нет → создаёт в текущем активном окне
 *   - Сохраняет tabId и windowId
 *
 * Вызывается ТОЛЬКО при явном действии пользователя (Start Sync).
 * НЕ вызывается автоматически при старте расширения.
 */
async function getOrCreateConnectionsTab() {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });

    if (existing.length > 0) {
      // Закрываем дубликаты — оставляем первую
      const dups = existing.slice(1).map(t => t.id).filter(Boolean);
      if (dups.length) {
        await chrome.tabs.remove(dups);
        console.log(`[CRM BG] Закрыты дубликаты connections: ${dups}`);
      }
      connectionsTabId    = existing[0].id;
      connectionsWindowId = existing[0].windowId;
      console.log(`[CRM BG] Window ID: ${connectionsWindowId} | Tab ID: ${connectionsTabId}`);
      return { tabId: connectionsTabId, windowId: connectionsWindowId };
    }

    // Нет вкладки — создаём в текущем активном окне
    const currentWindow = await chrome.windows.getCurrent({ windowTypes: ['normal'] });
    const targetWindowId = currentWindow?.id ?? chrome.windows.WINDOW_ID_NONE;

    const tab = await chrome.tabs.create({
      url:      LINKEDIN_CONNECTIONS_URL,
      active:   false,
      windowId: targetWindowId !== chrome.windows.WINDOW_ID_NONE ? targetWindowId : undefined
    });

    connectionsTabId    = tab.id;
    connectionsWindowId = tab.windowId;
    console.log(`[CRM BG] Создана вкладка connections. Window: ${connectionsWindowId}`);
    return { tabId: connectionsTabId, windowId: connectionsWindowId };

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
      const primary = found[0];
      const dups = found.slice(1).map(t => t.id).filter(Boolean);
      if (dups.length) await chrome.tabs.remove(dups);
      if (primary.windowId !== chrome.windows.WINDOW_ID_NONE)
        await chrome.windows.update(primary.windowId, { focused: true });
      if (typeof primary.id === 'number')
        await chrome.tabs.update(primary.id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (err) {
    console.error('[CRM BG] ensureDashboardTabActive:', err);
  }
}

// ── Profile scraping ───────────────────────────────────────────────────────

/**
 * Открывает вкладку профиля СТРОГО в том же окне что connections.
 * Делает вкладку активной — нужно для корректного рендеринга LinkedIn SPA.
 * Закрывает вкладку по завершению и возвращает фокус на connections.
 */
function scrapeOneProfile(profileUrl) {
  return new Promise(async (resolve) => {
    let tabId             = null;
    let messageListener   = null;
    let tabUpdateListener = null;
    let giveUpTimer       = null;

    // Таймаут 20 сек — с учётом fast scroll
    giveUpTimer = setTimeout(() => {
      console.warn('[CRM BG] Таймаут профиля:', profileUrl);
      cleanup(null);
    }, 20000);

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
        // Возвращаем фокус на connections
        if (connectionsTabId) {
          chrome.tabs.update(connectionsTabId, { active: true }).catch(() => {});
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
            console.log('[CRM BG] Parsed:', msg.data);
            cleanup(msg.data || null);
          }
        } catch { cleanup(msg.data || null); }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    try {
      // Если windowId устарел (окно закрылось) — восстанавливаем
      if (connectionsWindowId !== chrome.windows.WINDOW_ID_NONE) {
        try { await chrome.windows.get(connectionsWindowId); }
        catch {
          console.warn('[CRM BG] Окно закрылось — восстанавливаем');
          await getOrCreateConnectionsTab();
        }
      }

      const targetWindowId = connectionsWindowId !== chrome.windows.WINDOW_ID_NONE
        ? connectionsWindowId
        : undefined;

      console.log(`[CRM BG] Opening profile in correct window (${targetWindowId})`);

      // Открываем в том же окне, активной — LinkedIn требует видимости для рендеринга
      const tab = await chrome.tabs.create({
        url:      profileUrl,
        active:   true,
        windowId: targetWindowId
      });
      tabId = tab.id;

      tabUpdateListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
        tabUpdateListener = null;

        // Пауза — LinkedIn SPA догружает компоненты
        await new Promise(r => setTimeout(r, 1000));

        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['profile_scraper.js'] });
          console.log('[CRM BG] profile_scraper.js injected');
        } catch (err) {
          console.warn('[CRM BG] Инжекция не удалась:', err);
          cleanup(null);
        }
      };
      chrome.tabs.onUpdated.addListener(tabUpdateListener);

    } catch (err) {
      console.error('[CRM BG] Не удалось открыть вкладку профиля:', err);
      cleanup(null);
    }
  });
}

/**
 * Обогащает контакты данными профилей. Строго последовательно.
 * Resume-safe: пропускает контакты с уже заполненными полями.
 * Проверяет stop-команду перед каждым профилем.
 */
async function enrichContacts(contacts, pauseMs) {
  const enriched = [];

  for (let i = 0; i < contacts.length; i++) {
    const snap = await getStorage(['crm_sync_command']);
    if (snap.crm_sync_command === 'stop') {
      console.log(`[CRM BG] Enrichment stopped at ${i}/${contacts.length}`);
      for (let j = i; j < contacts.length; j++) {
        enriched.push({ ...contacts[j], jobTitle: '', company: '', school: '', major: '' });
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

    enriched.push({
      ...contact,
      jobTitle: data?.jobTitle || '',
      company:  data?.company  || '',
      school:   data?.school   || '',
      major:    data?.major    || ''
    });

    if (i < contacts.length - 1) {
      const pause = (pauseMs || 700) + Math.random() * 300;
      await new Promise(r => setTimeout(r, pause));
    }
  }

  return enriched;
}

// ── Обработчик сообщений ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ENSURE_CONTENT_SCRIPT
  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        // Получаем или создаём ровно одну вкладку connections
        const { tabId, windowId } = await getOrCreateConnectionsTab();

        if (!tabId) {
          sendResponse({ ok: false, reason: 'could_not_open_tab' });
          return;
        }

        // Ждём если только что создали
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length === 0) {
          await new Promise(r => setTimeout(r, 3500));
          sendResponse({ ok: true, created: true, windowId });
          return;
        }

        // Пингуем content.js
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

    enrichContacts(contacts, pauseMs)
      .then(enriched => sendResponse({ ok: true, enriched }))
      .catch(err => {
        console.error('[CRM BG] ENRICH_CONTACTS:', err);
        sendResponse({ ok: false, enriched: contacts });
      });
    return true;
  }

  // RESTART_SYNC
  if (msg.type === 'RESTART_SYNC') {
    (async () => {
      try {
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

        // Перезагружаем существующую вкладку connections
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length > 0) {
          const dups = tabs.slice(1).map(t => t.id).filter(Boolean);
          if (dups.length) await chrome.tabs.remove(dups);
          await chrome.tabs.reload(tabs[0].id);
          connectionsTabId    = tabs[0].id;
          connectionsWindowId = tabs[0].windowId;
        } else {
          // Нет вкладки — создаём
          await getOrCreateConnectionsTab();
        }

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[CRM BG] RESTART_SYNC:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // CONTENT_READY — НЕ автозапускаем
  if (msg.type === 'CONTENT_READY') {
    console.log('[CRM BG] content.js ready, tab:', sender.tab?.id, '— waiting for user action');
    sendResponse({ ok: true });
    return true;
  }

});

// ── Lifecycle ─────────────────────────────────────────────────────────────

// Клик по иконке расширения → открываем dashboard + connections
chrome.action.onClicked.addListener(() => {
  void (async () => {
    // Сначала открываем dashboard
    await ensureDashboardTabActive();
    // Затем connections — только при явном клике пользователя
    await getOrCreateConnectionsTab();
  })();
});

/**
 * При старте SW: сбрасываем зависший running-статус.
 * НЕ открываем connections автоматически — только при явном действии.
 */
void (async () => {
  const data = await getStorage(['crm_sync_status']);
  if (data.crm_sync_status === 'running') {
    console.log('[CRM BG] SW reboot: resetting stale running status');
    await chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
  }
  // Восстанавливаем windowId если вкладка connections уже открыта
  const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
  if (existing.length > 0) {
    connectionsTabId    = existing[0].id;
    connectionsWindowId = existing[0].windowId;
    console.log(`[CRM BG] Restored windowId: ${connectionsWindowId}`);
  }
})().catch(() => {});

// onStartup / onInstalled — НЕ открываем connections автоматически
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['crm_sync_status'], data => {
    if (data.crm_sync_status === 'running') {
      chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[CRM BG] Extension installed/updated');
});