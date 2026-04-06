/**
 * background.js — LinkedIn CRM v2.0
 *
 * Исправлено:
 *   1. enrichContacts проверяет crm_sync_command перед КАЖДЫМ профилем
 *      → остановка реально прерывает открытие новых вкладок
 *   2. Убран автозапуск через CONTENT_READY (был в старых версиях)
 *   3. При RESTART_SYNC — явно пишем crm_sync_command: null
 */

const LINKEDIN_CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const LINKEDIN_CONNECTIONS_PATTERNS = [
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/*'
];
const DASHBOARD_PATH = 'dashboard.html';

// ── Управление вкладками ──────────────────────────────────────────────────

async function ensureConnectionsTab(trigger) {
  try {
    const existing = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
    if (existing.length > 0) {
      const dups = existing.slice(1).map(t => t.id).filter(id => typeof id === 'number');
      if (dups.length) await chrome.tabs.remove(dups);
      return existing[0].id;
    }
    const tab = await chrome.tabs.create({ url: LINKEDIN_CONNECTIONS_URL, active: false });
    return tab.id;
  } catch (err) {
    console.error(`[CRM BG] ${trigger}:`, err);
    return null;
  }
}

async function ensureDashboardTabActive(trigger) {
  try {
    const pageUrl = chrome.runtime.getURL(DASHBOARD_PATH);
    const found   = await chrome.tabs.query({ url: pageUrl + '*' });
    if (found.length > 0) {
      const primary = found[0];
      const dups = found.slice(1).map(t => t.id).filter(id => typeof id === 'number');
      if (dups.length) await chrome.tabs.remove(dups);
      if (primary.windowId !== chrome.windows.WINDOW_ID_NONE)
        await chrome.windows.update(primary.windowId, { focused: true });
      if (typeof primary.id === 'number')
        await chrome.tabs.update(primary.id, { active: true });
      return;
    }
    await chrome.tabs.create({ url: pageUrl, active: true });
  } catch (err) {
    console.error(`[CRM BG] ${trigger} dashboard:`, err);
  }
}

// ── Вспомогательная: прочитать storage (Promise) ─────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

// ── Profile scraping ───────────────────────────────────────────────────────

/**
 * Открывает один профиль в фоновой вкладке, инжектирует profile_scraper.js,
 * получает данные, закрывает вкладку. Таймаут 15 сек.
 */
function scrapeOneProfile(profileUrl) {
  return new Promise(async (resolve) => {
    let tabId             = null;
    let messageListener   = null;
    let tabUpdateListener = null;
    let giveUpTimer       = null;

    giveUpTimer = setTimeout(() => {
      console.warn('[CRM BG] Таймаут профиля:', profileUrl);
      cleanup(null);
    }, 15000);

    function cleanup(result) {
      clearTimeout(giveUpTimer);
      if (messageListener)   chrome.runtime.onMessage.removeListener(messageListener);
      if (tabUpdateListener) chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
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
      const tab = await chrome.tabs.create({ url: profileUrl, active: false });
      tabId = tab.id;

      tabUpdateListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        await new Promise(r => setTimeout(r, 1500));
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['profile_scraper.js'] });
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
 * Обогащает массив контактов данными из профилей.
 * СТРОГО последовательно — один профиль за раз.
 *
 * ✅ ИСПРАВЛЕНО: перед каждым профилем проверяем crm_sync_command.
 * Если команда 'stop' — прерываем цикл и возвращаем что успели.
 * Необработанный хвост возвращаем без обогащения (данные не теряются).
 */
async function enrichContacts(contacts, pauseMs = 2000) {
  const enriched = [];

  for (let i = 0; i < contacts.length; i++) {
    // ── Проверяем стоп-команду перед каждым профилем ──
    const snap = await getStorage(['crm_sync_command']);
    if (snap.crm_sync_command === 'stop') {
      console.log(`[CRM BG] Обогащение прервано на ${i}/${contacts.length}`);
      // Добавляем необработанный хвост без обогащения — контакты не теряются
      for (let j = i; j < contacts.length; j++) {
        enriched.push({ ...contacts[j], jobTitle: null, company: null, school: null });
      }
      break;
    }

    const contact = contacts[i];

    // Уже обогащён (повторный запуск) — пропускаем
    if (contact.jobTitle || contact.company || contact.school) {
      enriched.push(contact);
      continue;
    }

    console.log(`[CRM BG] Профиль ${i + 1}/${contacts.length}: ${contact.profileUrl}`);
    const data = await scrapeOneProfile(contact.profileUrl);

    enriched.push({
      ...contact,
      jobTitle: data?.jobTitle || null,
      company:  data?.company  || null,
      school:   data?.school   || null
    });

    // Пауза между профилями
    if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, pauseMs + Math.random() * 1000));
    }
  }

  return enriched;
}

// ── Обработчик сообщений ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── ENSURE_CONTENT_SCRIPT ──
  if (msg.type === 'ENSURE_CONTENT_SCRIPT') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });

        if (tabs.length === 0) {
          const tabId = await ensureConnectionsTab('ensure_cs');
          if (!tabId) { sendResponse({ ok: false, reason: 'could_not_open_tab' }); return; }
          await new Promise(r => setTimeout(r, 3000));
          sendResponse({ ok: true, created: true });
          return;
        }

        const tabId = tabs[0].id;
        try {
          const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
          if (pong?.alive) { sendResponse({ ok: true, alive: true }); return; }
        } catch { /* инжектируем */ }

        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        sendResponse({ ok: true, injected: true });
      } catch (err) {
        console.error('[CRM BG] ENSURE_CONTENT_SCRIPT:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  // ── ENRICH_CONTACTS ──
  if (msg.type === 'ENRICH_CONTACTS') {
    const { contacts, pauseMs = 2000 } = msg;
    if (!contacts?.length) { sendResponse({ ok: true, enriched: [] }); return true; }

    enrichContacts(contacts, pauseMs)
      .then(enriched => sendResponse({ ok: true, enriched }))
      .catch(err => {
        console.error('[CRM BG] ENRICH_CONTACTS:', err);
        sendResponse({ ok: false, enriched: contacts });
      });
    return true;
  }

  // ── RESTART_SYNC ──
  if (msg.type === 'RESTART_SYNC') {
    (async () => {
      try {
        // Полный сброс storage
        await chrome.storage.local.set({
          crm_contacts:         [],
          crm_sync_count:       0,
          crm_sync_total:       null,
          crm_sync_percent:     0,
          crm_sync_label:       '',
          crm_sync_eta_seconds: null,
          crm_sync_status:      'idle',
          crm_sync_phase:       '',
          crm_sync_command:     null,  // ← явно null, не 'start'
          crm_heartbeat:        0
        });

        // Перезагружаем вкладку LinkedIn
        const tabs = await chrome.tabs.query({ url: LINKEDIN_CONNECTIONS_PATTERNS });
        if (tabs.length > 0) {
          await chrome.tabs.reload(tabs[0].id);
        } else {
          await chrome.tabs.create({ url: LINKEDIN_CONNECTIONS_URL, active: false });
        }

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[CRM BG] RESTART_SYNC:', err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  /**
   * CONTENT_READY — content.js сообщает что загрузился.
   * ✅ ИСПРАВЛЕНО: больше НЕ автозапускаем синхронизацию.
   * Синхронизация стартует ТОЛЬКО по явному нажатию кнопки в UI.
   */
  if (msg.type === 'CONTENT_READY') {
    console.log('[CRM BG] content.js готов, tab:', sender.tab?.id, '— ожидаем явного старта');
    sendResponse({ ok: true });
    return true;
  }

});

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(() => {
  void (async () => {
    await ensureConnectionsTab('action_click');
    await ensureDashboardTabActive('action_click');
  })();
});

/**
 * При старте Service Worker: сбрасываем зависший running-статус.
 * SW перезапустился → content.js мёртв → running зависнет без сброса.
 * ✅ Не запускаем синхронизацию автоматически.
 */
void (async () => {
  const data = await getStorage(['crm_sync_status']);
  if (data.crm_sync_status === 'running') {
    console.log('[CRM BG] SW reboot: сбрасываем зависший running');
    await chrome.storage.local.set({
      crm_sync_status:  'idle',
      crm_sync_command: null
    });
  }
  await ensureConnectionsTab('service_worker_boot');
})().catch(() => {});

chrome.runtime.onStartup.addListener(() => void ensureConnectionsTab('onStartup').catch(() => {}));
chrome.runtime.onInstalled.addListener(() => void ensureConnectionsTab('onInstalled').catch(() => {}));