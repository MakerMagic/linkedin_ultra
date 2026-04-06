/**
 * content.js — LinkedIn CRM v1.4
 *
 * Изменения:
 *   1. Завершение при остатке < 10: финальный harvest → статус done
 *   2. extractOccupationDetails: парсим jobTitle, company, school из карточки
 *   3. extractContact возвращает расширенный объект с новыми полями
 */
(function () {
  'use strict';

  // ⏱ Константа времени на 10 контактов (секунд)
  const TIME_PER_10 = 2;

  const CFG = {
    scrollPxMin:        400,
    scrollPxMax:        900,
    pauseAfterScroll:   700,
    pauseJitter:        600,
    waitNewCardsMs:     3000,
    pollTotalMs:        500,
    confirmScrolls:     2,
    maxEmptyCyclesFB:   8,
    heartbeatInterval:  4000,
    // Когда остаток меньше порога — завершаем после одного финального прохода
    nearEndThreshold:   10
  };

  // ── Stop Token ────────────────────────────────────────────────────────────

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
        if (token.cancelled) { clearTimeout(id); clearInterval(check); reject(new CancelledError()); }
      }, 50);
      setTimeout(() => clearInterval(check), ms + 100);
    });
  }

  // ── Состояние ─────────────────────────────────────────────────────────────

  let isRunning              = false;
  let currentToken           = null;
  let heartbeatTimer         = null;
  let seenUrls               = new Set();
  let _cachedScrollContainer = null;

  // ── Утилиты ───────────────────────────────────────────────────────────────

  function randomInt(min, max) { return Math.floor(min + Math.random() * (max - min)); }

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
    clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── Скролл ────────────────────────────────────────────────────────────────

  function findScrollContainer() {
    if (_cachedScrollContainer && document.contains(_cachedScrollContainer)) return _cachedScrollContainer;
    const anchor = document.querySelector('a[href*="/in/"]');
    if (anchor) {
      let el = anchor.parentElement;
      let depth = 0;
      while (el && el !== document.documentElement && depth < 20) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
          console.log(`[CRM] 📌 Контейнер (depth=${depth}):`, el.tagName, el.className.trim().split(/\s+/)[0] || '');
          _cachedScrollContainer = el;
          return el;
        }
        el = el.parentElement;
        depth++;
      }
    }
    if (document.body.scrollHeight > document.body.clientHeight + 100) {
      const ov = window.getComputedStyle(document.body).overflowY;
      if (ov !== 'hidden') { _cachedScrollContainer = document.body; return document.body; }
    }
    _cachedScrollContainer = document.documentElement;
    return document.documentElement;
  }

  function performScroll(px) {
    const container = findScrollContainer();
    const before    = container.scrollTop;
    container.scrollTop += px;
    const after = container.scrollTop;
    if (after === before && before > 0) { _cachedScrollContainer = null; }
    console.log(`[CRM] Скролл +${px}px | scrollTop: ${Math.round(before)}→${Math.round(after)}`);
  }

  // ── Total ─────────────────────────────────────────────────────────────────

  function getTotalFromHeader() {
    const header = document.querySelector('[componentKey="ConnectionsPage_ConnectionsListHeader"]');
    if (header) {
      const p   = header.querySelector('p');
      const num = parseConnectionCount((p?.textContent || header.textContent || '').trim());
      if (num) { console.log(`[CRM] ✅ Total: ${num}`); return num; }
    }
    const h1 = document.querySelector('main h1');
    if (h1) {
      const num = parseConnectionCount(h1.textContent || '');
      if (num) { console.log(`[CRM] ✅ Total (h1): ${num}`); return num; }
    }
    return null;
  }

  function parseConnectionCount(text) {
    if (!text || text.length > 100) return null;
    if (/mutual|shared|common|взаимн|общ(их|ий|ее)/i.test(text)) return null;
    const cleaned = text.replace(/connections?|connexions?|контакт[аов]*/gi, '').replace(/\+/g, '').trim();
    const m = cleaned.match(/(\d[\d,\s]*\d|\d)/);
    if (!m) return null;
    const num = parseInt(m[1].replace(/[\s,]/g, ''), 10);
    return (num && num >= 1 && num <= 30000) ? num : null;
  }

  function pollForTotal(token) {
    return new Promise(resolve => {
      const imm = getTotalFromHeader();
      if (imm) { resolve(imm); return; }
      const iv = setInterval(() => {
        if (token.cancelled) { clearInterval(iv); resolve(null); return; }
        const f = getTotalFromHeader();
        if (f) { clearInterval(iv); resolve(f); }
      }, CFG.pollTotalMs);
    });
  }

  // ── Парсинг occupation / опыта из карточки ────────────────────────────────

  /**
   * Проверяет является ли текст названием учебного заведения.
   */
  function isEducationalInstitution(text) {
    return /university|college|school|institute|academy|polytechnic|seminary|lyceum|лицей|колледж|университет|институт|академия/i.test(text);
  }

  /**
   * Парсит строку "Должность at Компания" → {jobTitle, company, school}.
   * Обрабатывает паттерны:
   *   "Software Engineer at Google"  → jobTitle:"Software Engineer", company:"Google"
   *   "Student at MIT"               → jobTitle:"Student", school:"MIT"
   *   "Harvard University"           → school:"Harvard University"
   *   "CEO"                          → jobTitle:"CEO"
   */
  function parseOccupationString(text) {
    if (!text) return { jobTitle: null, company: null, school: null };

    // Паттерн "Должность at Организация"
    const atMatch = text.match(/^(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      const title = atMatch[1].trim();
      const org   = atMatch[2].trim();
      if (isEducationalInstitution(org)) {
        return { jobTitle: title || null, company: null, school: org };
      }
      return { jobTitle: title || null, company: org, school: null };
    }

    // Текст без "at" — просто учебное заведение или должность
    if (isEducationalInstitution(text)) {
      return { jobTitle: null, company: null, school: text };
    }

    return { jobTitle: text, company: null, school: null };
  }

  /**
   * Извлекает jobTitle, company, school из карточки контакта.
   *
   * Слой 1 — специфичные componentKey-секции (появляются в новом UI LinkedIn):
   *   div._936a7c6b с componentKey, содержащим "ExperienceTopLevelSection" или "EducationTopLevelSection"
   *   Классы p-элементов как описано в ТЗ (могут меняться с обновлениями LinkedIn).
   *
   * Слой 2 — occupation/subtitle строка из карточки (универсальный fallback):
   *   Текст вида "Software Engineer at Google" → парсим через parseOccupationString().
   */
  function extractOccupationDetails(card) {
    let jobTitle = null;
    let company  = null;
    let school   = null;

    // ── Слой 1: componentKey-секции ──
    // Ищем div с атрибутом componentKey (атрибут нечувствителен к регистру в querySelector)
    const sections = card.querySelectorAll('div[componentKey], div[componentkey]');

    for (const section of sections) {
      const ck = (
        section.getAttribute('componentKey') ||
        section.getAttribute('componentkey') || ''
      );

      const isExp = /ExperienceTopLevelSection/i.test(ck);
      const isEdu = /EducationTopLevelSection/i.test(ck);

      if (!isExp && !isEdu) continue;

      if (isExp) {
        // Заголовок секции опыта (должность или учебное заведение как место работы)
        // Класс из ТЗ: _3f5c8efb ba487acf ... (жирный/основной текст)
        const titleEl =
          section.querySelector('p._3f5c8efb.ba487acf') ||
          section.querySelector('[class*="t-bold"]') ||
          section.querySelector('[class*="title"]');

        if (titleEl && !jobTitle) {
          const t = cleanText(titleEl);
          if (t) {
            if (isEducationalInstitution(t) && !school) school = t;
            else jobTitle = t;
          }
        }

        // Название компании
        // Класс из ТЗ: _3f5c8efb dd3e351e ... (вторичный текст)
        const companyEl =
          section.querySelector('p._3f5c8efb.dd3e351e') ||
          section.querySelector('[class*="subtitle"]');

        if (companyEl && !company) {
          const c = cleanText(companyEl);
          if (c) company = c;
        }
      }

      if (isEdu) {
        // Учебное заведение
        const schoolEl =
          section.querySelector('p._3f5c8efb.ba487acf') ||
          section.querySelector('[class*="t-bold"]');

        if (schoolEl && !school) {
          const s = cleanText(schoolEl);
          if (s) school = s;
        }
      }
    }

    // ── Слой 2: occupation/subtitle строка (fallback) ──
    // Если слой 1 ничего не дал — парсим простую строку из карточки
    if (!jobTitle && !company && !school) {
      const occupationEl =
        card.querySelector('.mn-connection-card__occupation') ||
        card.querySelector('[class*="occupation"]')           ||
        card.querySelector('[class*="subtitle"]')             ||
        card.querySelector('.entity-result__primary-subtitle')||
        card.querySelector('[class*="t-14"][class*="t-black"]');

      if (occupationEl) {
        const parsed = parseOccupationString(cleanText(occupationEl));
        jobTitle = parsed.jobTitle;
        company  = parsed.company;
        school   = parsed.school;
      }
    }

    return {
      jobTitle: jobTitle || null,
      company:  company  || null,
      school:   school   || null
    };
  }

  // ── DOM: ссылки и контакты ────────────────────────────────────────────────

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

  /**
   * Извлекает контакт из ссылки-профиля.
   * Теперь возвращает расширенный объект: profileUrl, fullName, jobTitle, company, school.
   */
  function extractContact(link) {
    const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
    if (!profileUrl) return null;

    // ── Имя ──
    let fullName = nameFromAriaLabel(link.getAttribute('aria-label'));

    if (!fullName) {
      const el = link.querySelector('[class*="name"], [class*="title-text"], [class*="person-name"]');
      if (el) fullName = cleanText(el);
    }
    if (!fullName) {
      const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]');
      if (card) {
        const el = card.querySelector('[class*="name"], [class*="title-text"], .artdeco-entity-lockup__title');
        if (el) fullName = cleanText(el);
      }
    }
    if (!fullName) {
      const card = link.closest('li, [class*="card"]');
      if (card) {
        const img = card.querySelector('img[alt]:not([alt=""])');
        if (img) fullName = (img.getAttribute('alt') || '').trim();
      }
    }
    if (!fullName) fullName = cleanText(link);
    if (!fullName || fullName.length < 2) return null;
    if (/^(linkedin|view|see|connect|follow|profile|\d+|message|more|open)$/i.test(fullName)) return null;

    // ── Occupation: jobTitle, company, school ──
    const card = link.closest('li, [class*="card"], [class*="result"], [class*="entity"]') || link.parentElement;
    const { jobTitle, company, school } = card
      ? extractOccupationDetails(card)
      : { jobTitle: null, company: null, school: null };

    return { profileUrl, fullName, jobTitle, company, school };
  }

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

  // ── MutationObserver ──────────────────────────────────────────────────────

  function waitForNewCards(currentCount, timeoutMs, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) { reject(new CancelledError()); return; }
      if (findProfileLinks().length > currentCount) { resolve('appeared'); return; }
      let done = false;
      const finish = reason => {
        if (done) return; done = true;
        clearTimeout(timer); clearInterval(cancelCheck); obs.disconnect();
        token.cancelled ? reject(new CancelledError()) : resolve(reason);
      };
      const timer       = setTimeout(() => finish('timeout'), timeoutMs);
      const cancelCheck = setInterval(() => { if (token.cancelled) finish('cancelled'); }, 100);
      const obs         = new MutationObserver(() => { if (findProfileLinks().length > currentCount) finish('appeared'); });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ── ETA ───────────────────────────────────────────────────────────────────

  function calcInitialSeconds(total) {
    if (!total || total <= 0) return null;
    return Math.ceil(total / 10) * TIME_PER_10;
  }

  // ── Прогресс ──────────────────────────────────────────────────────────────

  async function reportProgress(collected, total, phase, remainingSeconds = null, contacts = null) {
    let percent;
    if (total && total > 0) {
      percent = Math.round((collected / total) * 100);
      if (phase === 'running') percent = Math.min(99, percent);
    } else {
      percent = collected > 0 ? Math.min(15, Math.round(collected / 10)) : 1;
    }
    if (phase === 'done')    percent = 100;
    if (phase === 'stopped') percent = total ? Math.min(95, percent) : Math.min(50, percent);

    const label = total ? `Собрано ${collected} из ${total}` : `Собрано ${collected}`;

    const payload = {
      crm_sync_percent:     percent,
      crm_sync_count:       collected,
      crm_sync_total:       total,
      crm_sync_label:       label,
      crm_sync_eta_seconds: remainingSeconds !== null ? Math.max(0, remainingSeconds) : null,
      crm_sync_status:      phase === 'running' ? 'running' : phase,
      crm_sync_phase:       phase === 'running' ? 'scrolling' : phase
    };
    if (contacts !== null) payload.crm_contacts = contacts;

    await chrome.storage.local.set(payload);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => chrome.storage.local.set({ crm_heartbeat: Date.now() }), CFG.heartbeatInterval);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ── Главный цикл ──────────────────────────────────────────────────────────

  async function runSync(token) {
    console.log('[CRM] ══ Синхронизация v1.4 запущена ══');
    startHeartbeat();
    _cachedScrollContainer = null;

    let allContacts      = [];
    let total            = null;
    let emptyCycles      = 0;
    let confirmLeft      = 0;
    let remainingSeconds = null;
    let lastMilestone    = 0;

    if (findProfileLinks().length === 0) {
      console.log('[CRM] Ждём первых карточек...');
      try { await waitForNewCards(0, 15000, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, null); return; } }
    }

    const firstBatch = harvestNewContacts();
    allContacts.push(...firstBatch);
    total = getTotalFromHeader();
    findScrollContainer();

    if (total) {
      remainingSeconds = calcInitialSeconds(total);
      console.log(`[CRM] ⏱ Начальный таймер: ${remainingSeconds}с для ${total} контактов`);
    }

    console.log(`[CRM] Первый урожай: ${firstBatch.length}. Total: ${total ?? '(не найден)'}`);
    await reportProgress(allContacts.length, total, 'running', remainingSeconds, allContacts);

    if (!total) {
      pollForTotal(token).then(found => {
        if (found && !token.cancelled) {
          total = found;
          if (remainingSeconds === null) {
            remainingSeconds = calcInitialSeconds(found);
            console.log(`[CRM] ⏱ Polling total: ${found}, таймер: ${remainingSeconds}с`);
          }
        }
      });
    }

    while (true) {
      if (token.cancelled) { await onStopped(allContacts, total); return; }

      // ── Условия остановки ──

      if (total !== null && allContacts.length >= total) {
        // Собрали всё или больше
        if (confirmLeft < CFG.confirmScrolls) {
          confirmLeft++;
          console.log(`[CRM] Контрольный скролл ${confirmLeft}/${CFG.confirmScrolls}`);
        } else {
          console.log(`[CRM] ✓ Завершено: ${allContacts.length} >= ${total}`);
          break;
        }
      } else if (total === null && emptyCycles >= CFG.maxEmptyCyclesFB) {
        console.log('[CRM] Fallback-стоп');
        break;
      } else {
        confirmLeft = 0;
      }

      const countBefore = findProfileLinks().length;
      performScroll(randomInt(CFG.scrollPxMin, CFG.scrollPxMax));

      try { await waitForNewCards(countBefore, CFG.waitNewCardsMs, token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, total); return; } }

      try { await delayOrCancel(CFG.pauseAfterScroll + randomInt(0, CFG.pauseJitter), token); }
      catch (e) { if (e instanceof CancelledError) { await onStopped(allContacts, total); return; } }

      if (!total) {
        const f = getTotalFromHeader();
        if (f) {
          total = f;
          if (remainingSeconds === null) remainingSeconds = calcInitialSeconds(f);
          console.log(`[CRM] Total в итерации: ${total}`);
        }
      }

      const batch = harvestNewContacts();

      if (batch.length > 0) {
        allContacts.push(...batch);
        emptyCycles = 0;

        // Убываем таймер на каждые 10 контактов
        if (remainingSeconds !== null) {
          const newMilestone = Math.floor(allContacts.length / 10) * 10;
          if (newMilestone > lastMilestone) {
            const steps = (newMilestone - lastMilestone) / 10;
            remainingSeconds = Math.max(0, remainingSeconds - steps * TIME_PER_10);
            lastMilestone    = newMilestone;
          }
        }

        const pct = total ? `${Math.round(allContacts.length / total * 100)}%` : '?%';
        console.log(`[CRM] +${batch.length} | ${allContacts.length}${total ? `/${total}` : ''} (${pct})`);

        // ── ✅ ИСПРАВЛЕНИЕ: завершение при остатке < nearEndThreshold ──
        // Когда до total осталось < 10 контактов — LinkedIn уже не будет подгружать
        // новые карточки (лента закончилась). Делаем финальный harvest и выходим.
        if (total !== null && (total - allContacts.length) < CFG.nearEndThreshold && (total - allContacts.length) >= 0) {
          console.log(`[CRM] Остаток < ${CFG.nearEndThreshold} — финальный проход`);
          // Короткая пауза и один финальный сбор
          await new Promise(r => setTimeout(r, 1200));
          const finalBatch = harvestNewContacts();
          if (finalBatch.length > 0) {
            allContacts.push(...finalBatch);
            console.log(`[CRM] Финальный урожай: +${finalBatch.length}`);
          }
          console.log(`[CRM] ✓ Завершаем (собрано ${allContacts.length} из ${total})`);
          break;
        }

        await reportProgress(allContacts.length, total, 'running', remainingSeconds, allContacts);
      } else {
        emptyCycles++;
        console.log(`[CRM] Нет новых (${emptyCycles}${total ? `, осталось: ${total - allContacts.length}` : ''})`);
        await reportProgress(allContacts.length, total, 'running', remainingSeconds);
      }
    }

    // ── Финал ──
    stopHeartbeat();
    isRunning = false;

    await chrome.storage.local.set({
      crm_contacts:         allContacts,
      crm_sync_count:       allContacts.length,
      crm_sync_total:       total,
      crm_sync_percent:     100,
      crm_sync_label:       total ? `Собрано ${allContacts.length} из ${total}` : `Собрано ${allContacts.length}`,
      crm_sync_eta_seconds: null,   // завершено — ETA скрываем
      crm_sync_phase:       'done',
      crm_sync_status:      'done',
      crm_sync_command:     null
    });

    console.log(`[CRM] ✓ Готово: ${allContacts.length}${total ? `/${total}` : ''}`);
  }

  async function onStopped(contacts, total) {
    stopHeartbeat();
    isRunning = false;
    const percent = (total && total > 0)
      ? Math.min(95, Math.round((contacts.length / total) * 100))
      : Math.min(15, contacts.length > 0 ? Math.round(contacts.length / 10) : 0);

    await chrome.storage.local.set({
      crm_contacts:         contacts,
      crm_sync_count:       contacts.length,
      crm_sync_total:       total,
      crm_sync_percent:     percent,
      crm_sync_label:       total ? `Собрано ${contacts.length} из ${total}` : `Собрано ${contacts.length}`,
      crm_sync_eta_seconds: null,
      crm_sync_phase:       'stopped',
      crm_sync_status:      'stopped',
      crm_sync_command:     null
    });
    console.log(`[CRM] Остановлено: ${contacts.length}`);
  }

  // ── Точка входа ───────────────────────────────────────────────────────────

  function startSync() {
    if (isRunning) return;
    seenUrls               = new Set();
    _cachedScrollContainer = null;
    isRunning              = true;
    currentToken           = makeStopToken();

    chrome.storage.local.set({
      crm_sync_status:      'running',
      crm_sync_phase:       'scrolling',
      crm_sync_percent:     1,
      crm_sync_count:       0,
      crm_sync_total:       null,
      crm_sync_label:       'Запуск…',
      crm_sync_eta_seconds: null
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
    if (!isRunning || !currentToken) return;
    currentToken.cancelled = true;
  }

  // ── Команды ───────────────────────────────────────────────────────────────

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.crm_sync_command) return;
    const cmd = changes.crm_sync_command.newValue;
    if (cmd === 'start') startSync();
    if (cmd === 'stop')  stopSync();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ alive: true, isRunning }); return true; }
  });

  chrome.storage.local.get(['crm_sync_command'], data => {
    if (data.crm_sync_command === 'start') startSync();
  });

  if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});

  console.log('[CRM] content.js v1.4 готов');

})();