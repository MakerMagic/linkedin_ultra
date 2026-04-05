/**
 * content.js — LinkedIn CRM v1.0
 *
 * Исправлено:
 *   1. performScroll: скроллит DOM-контейнер (scrollTop), а не window
 *      → работает в фоновой вкладке
 *   2. getTotalFromHeader: ищет по componentKey атрибуту — стабильно
 *   3. pollForTotal: polling каждые 500мс без жёсткого таймаута
 *   4. reportProgress: добавлен crm_sync_label "Собрано X из Y"
 */
(function () {
  'use strict';

  // =====================================================================
  // КОНФИГУРАЦИЯ
  // =====================================================================

  const CFG = {
    scrollPxMin:        300,
    scrollPxMax:        700,
    pauseAfterScroll:   1500,
    pauseJitter:        1500,
    waitNewCardsMs:     5000,   // ждём новые карточки после скролла
    pollTotalMs:        500,    // интервал polling total
    confirmScrolls:     2,      // доп. скроллов после collected >= total
    maxEmptyCyclesFB:   8,      // стоп без total
    heartbeatInterval:  4000
  };

  // =====================================================================
  // STOP TOKEN
  // =====================================================================

  class CancelledError extends Error {
    constructor() { super('cancelled'); this.name = 'CancelledError'; }
  }

  function makeStopToken() { return { cancelled: false }; }

  function delayOrCancel(ms, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      const id = setTimeout(() => {
        if (token.cancelled) reject(new CancelledError()); else resolve();
      }, ms);
      const check = setInterval(() => {
        if (token.cancelled) {
          clearTimeout(id); clearInterval(check);
          reject(new CancelledError());
        }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  // =====================================================================
  // ГЛОБАЛЬНОЕ СОСТОЯНИЕ
  // =====================================================================

  let isRunning    = false;
  let currentToken = null;
  let heartbeatTimer = null;
  let seenUrls     = new Set();

  // =====================================================================
  // УТИЛИТЫ
  // =====================================================================

  function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function normalizeProfileUrl(href) {
    if (!href) return null;
    try {
      const base = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
      const m    = new URL(base).pathname.match(/^\/in\/([^/?#]+)/);
      return m ? 'https://www.linkedin.com/in/' + m[1] : null;
    } catch { return null; }
  }

  function nameFromAriaLabel(label) {
    if (!label) return null;
    let m = label.match(/^view\s+(.+?)(?:'s)?\s+profile$/i);
    if (m) return m[1].trim();
    m = label.match(/просмотреть профиль[:\s]+(.+)/i);
    if (m) return m[1].trim();
    return null;
  }

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]')
      .forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // =====================================================================
  // 🔧 FIX 1: СКРОЛЛ КОНТЕЙНЕРА (работает в фоновой вкладке)
  // =====================================================================

  /**
   * Находит реально прокручиваемый DOM-контейнер.
   *
   * Принцип: ищем элемент у которого scrollHeight > clientHeight + 50px.
   * Это означает что внутри есть контент для скролла.
   *
   * Важно: скроллим element.scrollTop — это работает в неактивных вкладках.
   * window.scrollBy({ behavior: 'smooth' }) Chrome замораживает в фоне.
   */
  function findScrollContainer() {
    // Приоритетные кандидаты — специфичные для LinkedIn
    const candidates = [
      // Основной контейнер скаффолдинга
      document.querySelector('.scaffold-layout__main'),
      document.querySelector('.scaffold-finite-scroll__content'),
      document.querySelector('.mn-connections__list'),
      document.querySelector('[data-view-name="connections-list"]'),
      // Общие fallback
      document.querySelector('main'),
      document.querySelector('#main'),
      document.documentElement  // <html> — всегда прокручиваем как последний resort
    ];

    for (const el of candidates) {
      if (!el) continue;
      // Проверяем что элемент реально прокручивается
      if (el === document.documentElement) return el; // последний fallback всегда
      if (el.scrollHeight > el.clientHeight + 50) {
        console.log(`[CRM] Контейнер скролла: ${el.tagName}.${el.className.split(' ')[0]}`);
        return el;
      }
    }

    return document.documentElement;
  }

  /**
   * Скроллит контейнер на px вниз.
   *
   * Не используем behavior: 'smooth' — Chrome приостанавливает анимацию
   * в неактивных вкладках и scrollBy не работает совсем.
   * scrollTop += работает всегда, в любой вкладке.
   */
  function performScroll(px) {
    const container = findScrollContainer();

    const before = container.scrollTop;
    container.scrollTop += px;
    const after = container.scrollTop;

    // Если контейнер не двигается — пробуем window через scrollY
    if (after === before && container !== document.documentElement) {
      document.documentElement.scrollTop += px;
    }

    console.log(
      `[CRM] Скролл +${px}px | scrollTop: ${Math.round(before)}→${Math.round(after)}` +
      ` | docH=${document.body.scrollHeight}`
    );
  }

  // =====================================================================
  // 🔧 FIX 2: ПАРСИНГ TOTAL ПО componentKey
  // =====================================================================

  /**
   * Ищет элемент с общим количеством контактов.
   *
   * LinkedIn рендерит счётчик в шапке списка:
   *   <div componentKey="ConnectionsPage_ConnectionsListHeader">
   *     <p>1,234</p>   ← или "1 234 connections"
   *   </div>
   *
   * Атрибут componentKey стабилен — LinkedIn не меняет его при рефакторинге CSS.
   */
  function getTotalFromHeader() {
    // Первый приоритет — componentKey (самый надёжный)
    const header = document.querySelector(
      '[componentKey="ConnectionsPage_ConnectionsListHeader"]'
    );

    if (header) {
      const p = header.querySelector('p');
      if (p) {
        const text = (p.textContent || '').trim();
        const num  = parseConnectionCount(text);
        if (num) {
          console.log(`[CRM] ✅ Total (componentKey): ${num} | текст: "${text}"`);
          return num;
        }
      }

      // Fallback внутри header: любой текстовый узел с числом
      const allText = (header.textContent || '').trim();
      const num = parseConnectionCount(allText);
      if (num) {
        console.log(`[CRM] ✅ Total (header textContent): ${num}`);
        return num;
      }
    }

    // Второй приоритет — заголовок страницы h1 в main (не в nav)
    const mainEl = document.querySelector('main');
    if (mainEl) {
      const h1 = mainEl.querySelector('h1');
      if (h1) {
        const num = parseConnectionCount(h1.textContent || '');
        if (num) {
          console.log(`[CRM] ✅ Total (main h1): ${num}`);
          return num;
        }
      }
    }

    return null;
  }

  /**
   * Парсит число из строк вида:
   *   "1,234"  "1 234"  "500+"  "1234 connections"  "1,234 контакта"
   *
   * Исключает: "mutual connections", "shared connections" — это общие знакомые.
   */
  function parseConnectionCount(text) {
    if (!text || text.length > 100) return null;

    // Исключаем строки об общих знакомых
    if (/mutual|shared|common|взаимн|общ(их|ий|ее)/i.test(text)) return null;

    // Убираем слова-суффиксы и парсим число
    const cleaned = text
      .replace(/connections?|connexions?|контакт[аов]*/gi, '')
      .replace(/\+/g, '')
      .trim();

    // Находим первое число (поддерживаем запятые и пробелы как разделители тысяч)
    const m = cleaned.match(/(\d[\d,\s]*\d|\d)/);
    if (!m) return null;

    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    if (!num || num < 1 || num > 30000) return null;

    return num;
  }

  // =====================================================================
  // 🔧 FIX 3: POLLING TOTAL (без жёсткого таймаута)
  // =====================================================================

  /**
   * Polling каждые 500мс пока:
   *   - total не найден
   *   - И token не отменён
   *
   * Не выбрасывает ошибку по таймауту — просто ждёт бесконечно.
   * Цикл сам продолжает работу даже если total не найден (fallback по emptyCycles).
   *
   * @returns {Promise<number|null>} — число или null если отменили
   */
  function pollForTotal(token) {
    return new Promise((resolve) => {
      // Уже есть?
      const immediate = getTotalFromHeader();
      if (immediate) { resolve(immediate); return; }

      const interval = setInterval(() => {
        if (token.cancelled) {
          clearInterval(interval);
          resolve(null);
          return;
        }

        const found = getTotalFromHeader();
        if (found) {
          clearInterval(interval);
          console.log(`[CRM] pollForTotal → нашли ${found}`);
          resolve(found);
        }
      }, CFG.pollTotalMs);
    });
  }

  // =====================================================================
  // ПОИСК ССЫЛОК НА ПРОФИЛИ
  // =====================================================================

  function findProfileLinks() {
    const links = [];
    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      const href = a.getAttribute('href') || '';
      if (!href.match(/\/in\/[^/?#]{2,}/)) continue;
      // Исключаем навигационные зоны
      if (a.closest('header, .global-nav, [role="navigation"], #global-nav')) continue;
      links.push(a);
    }
    return links;
  }

  // =====================================================================
  // ИЗВЛЕЧЕНИЕ КОНТАКТА
  // =====================================================================

  function extractContact(link) {
    const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
    if (!profileUrl) return null;

    let fullName = null;

    // 1. aria-label ("View John Doe's profile")
    fullName = nameFromAriaLabel(link.getAttribute('aria-label'));

    // 2. Дочерний span с именем
    if (!fullName) {
      const el = link.querySelector('[class*="name"], [class*="title-text"], [class*="person-name"]');
      if (el) fullName = cleanText(el);
    }

    // 3. Родительская карточка
    if (!fullName) {
      const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
      if (card) {
        const el = card.querySelector(
          '[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title'
        );
        if (el) fullName = cleanText(el);
      }
    }

    // 4. img[alt] с именем в аватаре
    if (!fullName) {
      const card = link.closest('li, [class*="card"]');
      if (card) {
        const img = card.querySelector('img[alt]:not([alt=""])');
        if (img) fullName = (img.getAttribute('alt') || '').trim();
      }
    }

    // 5. Текст самой ссылки
    if (!fullName) fullName = cleanText(link);

    if (!fullName || fullName.length < 2) return null;
    if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more|open)$/i.test(fullName)) return null;

    return { profileUrl, fullName };
  }

  // =====================================================================
  // ИНКРЕМЕНТАЛЬНЫЙ СБОР
  // =====================================================================

  function harvestNewContacts() {
    const fresh = [];
    for (const link of findProfileLinks()) {
      const contact = extractContact(link);
      if (!contact) continue;
      if (seenUrls.has(contact.profileUrl)) continue;
      seenUrls.add(contact.profileUrl);
      fresh.push(contact);
    }
    return fresh;
  }

  // =====================================================================
  // ОЖИДАНИЕ НОВЫХ КАРТОЧЕК (MutationObserver)
  // =====================================================================

  function waitForNewCards(currentCount, timeoutMs, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      if (findProfileLinks().length > currentCount) { resolve('appeared'); return; }

      let done = false;
      const finish = reason => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(cancelCheck);
        obs.disconnect();
        if (token.cancelled) reject(new CancelledError());
        else resolve(reason);
      };

      const timer       = setTimeout(() => finish('timeout'), timeoutMs);
      const cancelCheck = setInterval(() => { if (token.cancelled) finish('cancelled'); }, 100);
      const obs         = new MutationObserver(() => {
        if (findProfileLinks().length > currentCount) finish('appeared');
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // =====================================================================
  // 🔧 FIX 4: ПРОГРЕСС В STORAGE (с лейблом "Собрано X из Y")
  // =====================================================================

  /**
   * Сохраняет прогресс в storage.
   * Добавляет crm_sync_label — строку для отображения в UI.
   *
   * @param {number} collected
   * @param {number|null} total
   * @param {'running'|'done'|'stopped'} phase
   * @param {Array|null} contacts — если null, не перезаписываем
   */
  async function reportProgress(collected, total, phase, contacts = null) {
    let percent;

    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (phase === 'running') percent = Math.min(99, percent);
    } else {
      // Total неизвестен — кольцо не заполняем, держим маленькое значение
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }

    if (phase === 'done')    percent = 100;
    if (phase === 'stopped') percent = total ? Math.min(95, percent) : Math.min(50, percent);

    // Строка для UI: "Собрано 347 из 1234" или просто "Собрано 347"
    const label = total
      ? `Собрано ${collected} из ${total}`
      : `Собрано ${collected}`;

    const payload = {
      crm_sync_percent: percent,
      crm_sync_count:   collected,
      crm_sync_total:   total,
      crm_sync_label:   label,
      crm_sync_status:  phase === 'running' ? 'running' : phase,
      crm_sync_phase:   phase === 'running' ? 'scrolling' : phase
    };
    if (contacts !== null) payload.crm_contacts = contacts;

    await chrome.storage.local.set(payload);
  }

  // =====================================================================
  // HEARTBEAT
  // =====================================================================

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(
      () => chrome.storage.local.set({ crm_heartbeat: Date.now() }),
      CFG.heartbeatInterval
    );
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // =====================================================================
  // ГЛАВНЫЙ ЦИКЛ
  // =====================================================================

  async function runSync(token) {
    console.log('[CRM] ══ Синхронизация запущена ══');
    startHeartbeat();

    let allContacts = [];
    let total       = null;
    let emptyCycles = 0;
    let confirmLeft = 0;

    // Ждём первых карточек (SPA грузит асинхронно)
    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try {
        await waitForNewCards(0, 15000, token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, null); return; }
      }
    }

    // Первый урожай + немедленная попытка найти total
    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    total = getTotalFromHeader();

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(ещё не найден)'}`);
    await reportProgress(allContacts.length, total, 'running', allContacts);

    // Если total не найден сразу — запускаем polling параллельно с циклом
    // Polling сам запишет total когда найдёт
    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) {
          total = found;
          console.log(`[CRM] Параллельный polling нашёл total: ${found}`);
        }
      });
    }

    // ── Основной цикл ──
    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // Условие остановки: собрали >= total
      if (total !== null && allContacts.length >= total) {
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++;
          console.log(`[CRM] Достигнут total=${total}. Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
        } else {
          console.log(`[CRM] ✓ Завершено: ${allContacts.length} >= ${total}`);
          break;
        }
      } else if (total === null) {
        // Fallback: total неизвестен — останавливаемся по emptyCycles
        if (emptyCycles >= CFG.maxEmptyCyclesFB) {
          console.log(`[CRM] Fallback-стоп: ${emptyCycles} пустых скроллов без total`);
          break;
        }
      } else {
        confirmLeft = 0;
      }

      // ── Скролл (работает в фоновой вкладке) ──
      const countBefore = findProfileLinks().length;
      performScroll(randomInt(CFG.scrollPxMin, CFG.scrollPxMax));

      // Ждём новые карточки через MutationObserver
      try {
        await waitForNewCards(countBefore, CFG.waitNewCardsMs, token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      // Короткая пауза — LinkedIn рендерит постепенно
      try {
        await delayOrCancel(CFG.pauseAfterScroll + randomInt(0, CFG.pauseJitter), token);
      } catch (e) {
        if (e instanceof CancelledError) { await onStopped(allContacts, total); return; }
      }

      // Пробуем ещё раз найти total если ещё нет
      if (!total) {
        const found = getTotalFromHeader();
        if (found) {
          total = found;
          console.log(`[CRM] ✅ Total найден в итерации: ${total}`);
        }
      }

      // Собираем новые контакты
      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;
        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct})`);
        await reportProgress(allContacts.length, total, 'running', allContacts);
      } else {
        emptyCycles++;
        console.log(
          `[CRM] Нет новых (пустых: ${emptyCycles}` +
          `${total ? `, осталось: ${total - allContacts.length}` : ''})`
        );
        await reportProgress(allContacts.length, total, 'running');
      }
    }

    // ── Финал ──
    stopHeartbeat();
    isRunning = false;

    await chrome.storage.local.set({
      crm_contacts:     allContacts,
      crm_sync_count:   allContacts.length,
      crm_sync_total:   total,
      crm_sync_percent: 100,
      crm_sync_label:   total ? `Собрано ${allContacts.length} из ${total}` : `Собрано ${allContacts.length}`,
      crm_sync_phase:   'done',
      crm_sync_status:  'done',
      crm_sync_command: null
    });

    console.log(`[CRM] ✓ Готово. Собрано: ${allContacts.length}${total ? `/${total}` : ''}`);
  }

  async function onStopped(contacts, total) {
    stopHeartbeat();
    isRunning = false;

    const percent = (total && total > 0)
      ? Math.min(95, Math.round((contacts.length / total) * 100))
      : Math.min(15, contacts.length > 0 ? Math.round(contacts.length / 10) : 0);

    await chrome.storage.local.set({
      crm_contacts:     contacts,
      crm_sync_count:   contacts.length,
      crm_sync_total:   total,
      crm_sync_percent: percent,
      crm_sync_label:   total ? `Собрано ${contacts.length} из ${total}` : `Собрано ${contacts.length}`,
      crm_sync_phase:   'stopped',
      crm_sync_status:  'stopped',
      crm_sync_command: null
    });

    console.log(`[CRM] Остановлено. Сохранено: ${contacts.length}`);
  }

  // =====================================================================
  // ТОЧКА ВХОДА
  // =====================================================================

  function startSync() {
    if (isRunning) { console.log('[CRM] Уже запущено'); return; }

    // Сбрасываем Set — чистая сессия
    seenUrls = new Set();

    isRunning    = true;
    currentToken = makeStopToken();

    chrome.storage.local.set({
      crm_sync_status:  'running',
      crm_sync_phase:   'scrolling',
      crm_sync_percent: 1,
      crm_sync_count:   0,
      crm_sync_total:   null,
      crm_sync_label:   'Запуск…'
    });

    runSync(currentToken).catch(err => {
      if (err instanceof CancelledError) return;
      console.error('[CRM] Критическая ошибка:', err);
      stopHeartbeat();
      isRunning = false;
      chrome.storage.local.set({ crm_sync_status: 'error', crm_sync_command: null });
    });
  }

  function stopSync() {
    if (!isRunning) return;
    console.log('[CRM] STOP → отменяем токен');
    if (currentToken) currentToken.cancelled = true;
  }

  // =====================================================================
  // КОМАНДЫ
  // =====================================================================

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.crm_sync_command) return;
    const cmd = changes.crm_sync_command.newValue;
    if (cmd === 'start') startSync();
    if (cmd === 'stop')  stopSync();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ alive: true, isRunning }); return true; }
  });

  // Автостарт при загрузке
  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') {
      console.log('[CRM] Автостарт при загрузке');
      startSync();
    }
  });

  if (chrome.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
  }

  console.log('[CRM] content.js v1.0 готов');

})();