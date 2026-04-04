/**
 * content.js — LinkedIn CRM v0.5
 *
 * Архитектура двух фаз:
 *   Фаза 1 (0–50%):  скроллим до конца страницы, ждём подгрузки всех карточек
 *   Фаза 2 (50–100%): проходим по всем карточкам и собираем контакты
 *
 * Только чтение DOM — никаких мутаций.
 */
(function () {
    'use strict';
  
    // =====================================================================
    // КОНФИГУРАЦИЯ
    // =====================================================================
  
    const CFG = {
      scrollDelayMin:    1500,  // мс — мин пауза между скроллами
      scrollDelayMax:    3000,  // мс — макс пауза (имитация человека)
      waitForCardsMs:    6000,  // мс — ждём новых карточек после скролла
      maxEmptyCycles:    4,     // N раз нет новых → конец страницы
      scrollHeightSame:  3,     // N раз высота не изменилась → конец
      collectBatchSize:  50,    // Обрабатываем за один тик
      heartbeatInterval: 5000   // мс — маяк жизни
    };
  
    // =====================================================================
    // СОСТОЯНИЕ
    // =====================================================================
  
    let isRunning      = false;
    let heartbeatTimer = null;
  
    // =====================================================================
    // УТИЛИТЫ
    // =====================================================================
  
    function delay(min, max) {
      return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
    }
  
    /** Скролл с рандомной амплитудой — имитация человека */
    function humanScroll() {
      const factor = 0.5 + Math.random() * 1.0; // 50–150% высоты экрана
      window.scrollBy({ top: Math.round(window.innerHeight * factor), behavior: 'smooth' });
    }
  
    /**
     * Нормализует href → канонический URL профиля.
     * /in/john-doe?... → https://www.linkedin.com/in/john-doe
     */
    function normalizeProfileUrl(href) {
      if (!href) return null;
      try {
        const base = href.startsWith('http')
          ? href
          : 'https://www.linkedin.com' + href;
        const u = new URL(base);
        const m = u.pathname.match(/^\/in\/([^/?#]+)/);
        return m ? 'https://www.linkedin.com/in/' + m[1] : null;
      } catch { return null; }
    }
  
    /**
     * Извлекает имя из aria-label ссылки.
     * EN: "View John Doe's profile" → "John Doe"
     * RU: "Просмотреть профиль: John Doe" → "John Doe"
     */
    function nameFromAriaLabel(label) {
      if (!label) return null;
      let m = label.match(/^view\s+(.+?)(?:'s)?\s+profile$/i);
      if (m) return m[1].trim();
      m = label.match(/просмотреть профиль[:\s]+(.+)/i);
      if (m) return m[1].trim();
      return null;
    }
  
    /** Текст элемента без скрытых sr-only спанов */
    function cleanText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]')
        .forEach(n => n.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }
  
    // =====================================================================
    // ПОИСК ССЫЛОК НА ПРОФИЛИ В DOM
    // =====================================================================
  
    /**
     * Возвращает все <a href="/in/..."> исключая навигацию.
     * Стабильнее чем поиск по классам — LinkedIn их меняет постоянно.
     */
    function findProfileLinks() {
      const links = [];
      for (const a of document.querySelectorAll('a[href*="/in/"]')) {
        const href = a.getAttribute('href') || '';
        if (!href.match(/\/in\/[^/?#]{2,}/)) continue;
        if (a.closest('header, .global-nav, [role="navigation"], #global-nav')) continue;
        links.push(a);
      }
      return links;
    }
  
    // =====================================================================
    // ИЗВЛЕЧЕНИЕ ДАННЫХ ИЗ ОДНОЙ ССЫЛКИ
    // =====================================================================
  
    function extractContact(link) {
      const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
      if (!profileUrl) return null;
  
      let fullName = null;
  
      // 1. aria-label на самой ссылке (надёжнее всего)
      fullName = nameFromAriaLabel(link.getAttribute('aria-label'));
  
      // 2. Дочерний элемент с классом *name*
      if (!fullName) {
        const nameEl = link.querySelector(
          '[class*="name"], [class*="title-text"], [class*="person-name"]'
        );
        if (nameEl) fullName = cleanText(nameEl);
      }
  
      // 3. Родительская карточка
      if (!fullName) {
        const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
        if (card) {
          const nameEl = card.querySelector(
            '[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title'
          );
          if (nameEl) fullName = cleanText(nameEl);
        }
      }
  
      // 4. Alt аватара
      if (!fullName) {
        const card2 = link.closest('li, [class*="card"]');
        if (card2) {
          const img = card2.querySelector('img[alt]:not([alt=""])');
          if (img) fullName = (img.getAttribute('alt') || '').trim();
        }
      }
  
      // 5. Текст самой ссылки
      if (!fullName) fullName = cleanText(link);
  
      if (!fullName || fullName.length < 2) return null;
      if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more)$/i.test(fullName)) return null;
  
      return { profileUrl, fullName };
    }
  
    // =====================================================================
    // ОЖИДАНИЕ НОВЫХ КАРТОЧЕК (MutationObserver)
    // =====================================================================
  
    /**
     * Ждёт появления НОВЫХ ссылок сверх currentCount.
     * @returns {Promise<'appeared'|'timeout'>}
     */
    function waitForMoreLinks(currentCount, timeoutMs) {
      return new Promise(resolve => {
        if (findProfileLinks().length > currentCount) {
          resolve('appeared');
          return;
        }
  
        let settled = false;
        const finish = reason => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          obs.disconnect();
          resolve(reason);
        };
  
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        const obs   = new MutationObserver(() => {
          if (findProfileLinks().length > currentCount) finish('appeared');
        });
        obs.observe(document.body, { childList: true, subtree: true });
      });
    }
  
    // =====================================================================
    // HEARTBEAT — маяк жизни для dashboard
    // =====================================================================
  
    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        chrome.storage.local.set({ crm_heartbeat: Date.now() });
      }, CFG.heartbeatInterval);
    }
  
    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }
  
    // =====================================================================
    // РЕПОРТ ПРОГРЕССА В STORAGE
    // =====================================================================
  
    async function reportProgress(percent, phase, count, contacts = null) {
      const payload = {
        crm_sync_percent: Math.round(percent),
        crm_sync_phase:   phase,
        crm_sync_count:   count,
        crm_sync_status:  (phase === 'done' || phase === 'stopped') ? phase : 'running'
      };
      if (contacts !== null) payload.crm_contacts = contacts;
      await chrome.storage.local.set(payload);
    }
  
    // =====================================================================
    // ФАЗА 1: СКРОЛЛИНГ ДО КОНЦА СТРАНИЦЫ (0–50%)
    // =====================================================================
  
    async function phaseScroll() {
      console.log('[CRM] ▶ Фаза 1: скроллинг');
  
      let emptyCycles      = 0;
      let prevScrollHeight = 0;
      let sameHeightCount  = 0;
      let scrollIteration  = 0;
  
      // Ждём первых карточек (SPA грузит асинхронно)
      if (findProfileLinks().length === 0) {
        console.log('[CRM] Ждём первых карточек...');
        await waitForMoreLinks(0, 12000);
      }
  
      while (isRunning) {
        // Проверяем команду STOP
        const snap = await chrome.storage.local.get(['crm_sync_command']);
        if (snap.crm_sync_command === 'stop') {
          console.log('[CRM] STOP во время скролла');
          return 'stopped';
        }
  
        const countBefore   = findProfileLinks().length;
        const currentHeight = document.body.scrollHeight;
        scrollIteration++;
  
        // Прогресс фазы 1: 2% → 48% (нет точного total — растём по итерациям)
        const phase1Pct = Math.min(48, 2 + scrollIteration * 3 - emptyCycles * 4);
        await reportProgress(Math.max(2, phase1Pct), 'scrolling', countBefore);
  
        console.log(`[CRM] Скролл #${scrollIteration}. Ссылок: ${countBefore}. Height: ${currentHeight}`);
  
        humanScroll();
  
        const waitResult = await waitForMoreLinks(countBefore, CFG.waitForCardsMs);
  
        if (waitResult === 'timeout') {
          emptyCycles++;
          console.log(`[CRM] Нет новых (${emptyCycles}/${CFG.maxEmptyCycles})`);
        } else {
          emptyCycles = 0;
          await delay(400, 800); // Даём LinkedIn дорендерить
        }
  
        // Контроль высоты страницы
        if (currentHeight === prevScrollHeight) {
          sameHeightCount++;
        } else {
          sameHeightCount = 0;
        }
        prevScrollHeight = document.body.scrollHeight;
  
        // Двойной критерий конца:
        const reachedEnd =
          emptyCycles >= CFG.maxEmptyCycles ||
          (sameHeightCount >= CFG.scrollHeightSame && emptyCycles >= 1);
  
        if (reachedEnd) {
          console.log('[CRM] ✓ Конец страницы достигнут');
          break;
        }
  
        // Человеческая пауза
        const longPause = Math.random() < 0.12;
        await delay(
          longPause ? 3500 : CFG.scrollDelayMin,
          longPause ? 6000 : CFG.scrollDelayMax
        );
      }
  
      return isRunning ? 'done' : 'stopped';
    }
  
    // =====================================================================
    // ФАЗА 2: СБОР ДАННЫХ (50–100%)
    // =====================================================================
  
    async function phaseCollect(existingUrls) {
      console.log('[CRM] ▶ Фаза 2: сбор контактов');
  
      const allLinks = findProfileLinks();
      const total    = allLinks.length;
      const seenUrls = new Set(existingUrls);
      const contacts = [];
  
      console.log(`[CRM] Всего ссылок: ${total}`);
  
      for (let i = 0; i < allLinks.length; i++) {
        if (!isRunning) break;
  
        const contact = extractContact(allLinks[i]);
        if (contact && !seenUrls.has(contact.profileUrl)) {
          seenUrls.add(contact.profileUrl);
          contacts.push(contact);
        }
  
        // Репортим каждые N элементов
        if ((i + 1) % CFG.collectBatchSize === 0 || i === allLinks.length - 1) {
          const phase2Pct = 50 + ((i + 1) / total) * 49; // до 99%
          await reportProgress(Math.min(99, phase2Pct), 'collecting', contacts.length);
          await new Promise(r => setTimeout(r, 0)); // уступаем event loop
        }
      }
  
      return contacts;
    }
  
    // =====================================================================
    // ГЛАВНЫЙ ЦИКЛ
    // =====================================================================
  
    async function runSync() {
      console.log('[CRM] ══ Запуск синхронизации ══');
      isRunning = true;
      startHeartbeat();
  
      await reportProgress(0, 'scrolling', 0);
  
      // Ранее собранные контакты (дедупликация между сессиями)
      const stored       = await chrome.storage.local.get(['crm_contacts']);
      const existing     = Array.isArray(stored.crm_contacts) ? stored.crm_contacts : [];
      const existingUrls = existing.map(c => c.profileUrl).filter(Boolean);
      console.log(`[CRM] Ранее: ${existing.length} контактов`);
  
      // ── Фаза 1: скролл ──
      const scrollResult = await phaseScroll();
  
      if (scrollResult === 'stopped') {
        stopHeartbeat();
        isRunning = false;
        await reportProgress(0, 'stopped', existing.length);
        return;
      }
  
      // Пауза перед сбором — даём странице устояться
      await delay(800, 1500);
      await reportProgress(50, 'collecting', 0);
  
      // ── Фаза 2: сбор ──
      const newContacts = await phaseCollect(existingUrls);
      const allContacts = [...existing, ...newContacts];
  
      // Финальная запись
      const finalStatus = isRunning ? 'done' : 'stopped';
      stopHeartbeat();
      isRunning = false;
  
      await chrome.storage.local.set({
        crm_contacts:      allContacts,
        crm_sync_percent:  finalStatus === 'done' ? 100 : 50,
        crm_sync_phase:    finalStatus,
        crm_sync_count:    allContacts.length,
        crm_sync_status:   finalStatus,
        crm_sync_command:  null
      });
  
      console.log(`[CRM] ✓ Готово. Новых: ${newContacts.length}. Всего: ${allContacts.length}`);
    }
  
    // =====================================================================
    // КОМАНДЫ ЧЕРЕЗ chrome.storage
    // =====================================================================
  
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.crm_sync_command) return;
      const cmd = changes.crm_sync_command.newValue;
  
      if (cmd === 'start' && !isRunning) {
        console.log('[CRM] Команда START');
        runSync().catch(err => {
          console.error('[CRM] Ошибка:', err);
          stopHeartbeat();
          isRunning = false;
          chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
        });
      }
  
      if (cmd === 'stop') {
        console.log('[CRM] Команда STOP');
        isRunning = false;
      }
    });
  
    // =====================================================================
    // ОТВЕТ НА PING
    // =====================================================================
  
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'PING') sendResponse({ alive: true, isRunning });
    });
  
    // =====================================================================
    // АВТОВОССТАНОВЛЕНИЕ / АВТОЗАПУСК
    // =====================================================================
  
    chrome.storage.local.get(['crm_sync_command', 'crm_sync_status'], data => {
      if (data.crm_sync_command === 'start' && !isRunning) {
        console.log('[CRM] Автозапуск (восстановление или команда из background)');
        runSync().catch(console.error);
      }
    });
  
    // Сообщаем background что готовы
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  
    console.log('[CRM] content.js v0.5 загружен');
  
  })();