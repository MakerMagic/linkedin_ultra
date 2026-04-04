/**
 * dashboard.js — LinkedIn CRM v0.5
 *
 * Что изменилось:
 *   1. Прогресс-кольцо показывает реальный % (не спиннер)
 *   2. Статус различает фазу: «Скроллинг...» / «Сбор контактов...»
 *   3. CSV — две колонки: Profile URL | Full Name
 *   4. Кнопка «Начать» — fallback для ручного запуска
 *   5. Heartbeat-проверка при открытии dashboard
 */
(function () {
  'use strict';

  // ── Константы ──────────────────────────────────────────────────────────────
  const CIRCUMFERENCE      = 2 * Math.PI * 52; // r=52, см. SVG
  const HEARTBEAT_STALE_MS = 15_000;           // мс без heartbeat → считаем упавшим

  // ── DOM ────────────────────────────────────────────────────────────────────
  const navButtons = document.querySelectorAll('.nav__item[data-nav]:not([disabled])');
  const panels     = document.querySelectorAll('.main-panel[data-panel]');

  const arc       = document.getElementById('progressArc');
  const pctEl     = document.getElementById('progressPercent');
  const statusEl  = document.getElementById('syncStatus');
  const countEl   = document.getElementById('syncCount');
  const btnStart  = document.getElementById('btnStart');
  const btnStop   = document.getElementById('btnStop');
  const btnCSV    = document.getElementById('btnDownloadCSV');

  // =====================================================================
  // НАВИГАЦИЯ
  // =====================================================================

  function setActiveView(viewId) {
    navButtons.forEach(btn => {
      const id     = btn.getAttribute('data-nav');
      const active = id === viewId;
      btn.classList.toggle('nav__item--active', active);
      active
        ? btn.setAttribute('aria-current', 'page')
        : btn.removeAttribute('aria-current');
    });
    panels.forEach(p => {
      p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === viewId);
    });
    document.title = viewId === 'search'
      ? 'LinkedIn CRM — Поиск'
      : 'LinkedIn CRM — Синхронизация';
  }

  navButtons.forEach(btn => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-nav');
    if (id) setActiveView(id);
  }));

  document.querySelectorAll('[data-go-sync]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); setActiveView('sync'); });
  });

  // =====================================================================
  // КОЛЬЦО ПРОГРЕССА
  // =====================================================================

  function setRingProgress(pct) {
    const p = Math.max(0, Math.min(100, pct));
    if (arc) {
      arc.style.strokeDasharray  = String(CIRCUMFERENCE);
      arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100));
    }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // =====================================================================
  // ПРИМЕНЕНИЕ СОСТОЯНИЯ К UI
  // =====================================================================

  /**
   * @param {string} status  — 'idle'|'running'|'done'|'stopped'|'error'
   * @param {string} phase   — 'scrolling'|'collecting'|'done'|'stopped'|''
   * @param {number} count   — количество контактов
   * @param {number} percent — 0–100
   */
  function applyState(status, phase, count, percent) {
    const running     = status === 'running';
    const hasContacts = count > 0;

    // Кнопки
    if (btnStart) btnStart.disabled = running;
    if (btnStop)  btnStop.disabled  = !running;
    if (btnCSV)   btnCSV.disabled   = !hasContacts;

    // Счётчик
    if (countEl) countEl.textContent = String(count);

    // Статус — различаем фазы
    let statusText;
    if (status === 'running') {
      statusText = phase === 'collecting'
        ? 'Сбор контактов…'
        : 'Скроллинг страницы…';
    } else {
      const labels = {
        idle:    'Ожидание запуска',
        done:    'Завершено ✓',
        stopped: 'Остановлено',
        error:   'Ошибка — смотри консоль вкладки LinkedIn'
      };
      statusText = labels[status] || 'Ожидание запуска';
    }
    if (statusEl) statusEl.textContent = statusText;

    // Кольцо: реальный процент
    if (status === 'idle') {
      setRingProgress(0);
    } else {
      setRingProgress(percent);
    }

    // Текст кнопки «Начать»
    if (btnStart) {
      btnStart.textContent =
        hasContacts && !running && (status === 'stopped')
          ? 'Продолжить синхронизацию'
          : 'Начать синхронизацию';
    }
  }

  // =====================================================================
  // ПРОВЕРКА HEARTBEAT
  // =====================================================================

  async function loadAndApplyState() {
    return new Promise(resolve => {
      chrome.storage.local.get(
        ['crm_sync_status', 'crm_sync_phase', 'crm_sync_count', 'crm_sync_percent', 'crm_heartbeat'],
        data => {
          let status  = data.crm_sync_status  || 'idle';
          const phase   = data.crm_sync_phase   || '';
          const count   = data.crm_sync_count   || 0;
          const percent = data.crm_sync_percent  || 0;
          const hb      = data.crm_heartbeat    || 0;
          const stale   = Date.now() - hb > HEARTBEAT_STALE_MS;

          // Если статус «running» но heartbeat устарел → process упал
          if (status === 'running' && stale) {
            console.log('[CRM Dashboard] Зависший running → сброс в idle');
            status = 'idle';
            chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
          }

          applyState(status, phase, count, percent);
          resolve();
        }
      );
    });
  }

  // =====================================================================
  // ИНИЦИАЛИЗАЦИЯ
  // =====================================================================

  void loadAndApplyState();

  // Live-обновления от content.js
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = ['crm_sync_status', 'crm_sync_phase', 'crm_sync_count', 'crm_sync_percent'];
    if (!relevant.some(k => k in changes)) return;

    chrome.storage.local.get(
      ['crm_sync_status', 'crm_sync_phase', 'crm_sync_count', 'crm_sync_percent'],
      data => applyState(
        data.crm_sync_status  || 'idle',
        data.crm_sync_phase   || '',
        data.crm_sync_count   || 0,
        data.crm_sync_percent || 0
      )
    );
  });

  // =====================================================================
  // КНОПКА «НАЧАТЬ» — ручной запуск (fallback, если автозапуск не сработал)
  // =====================================================================

  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Подключение к LinkedIn…';

    // Проверяем что content.js жив
    const ok = await ensureContentScript();
    if (!ok) {
      if (statusEl) statusEl.textContent = 'Ошибка: откройте вкладку LinkedIn Connections';
      if (btnStart) btnStart.disabled = false;
      return;
    }

    chrome.storage.local.set({
      crm_sync_command: 'start',
      crm_sync_status:  'running'
    });
  }

  function ensureContentScript() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT' }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[CRM Dashboard] ensureContentScript:', chrome.runtime.lastError.message);
          resolve(true); // Пробуем продолжить
          return;
        }
        resolve(response?.ok !== false);
      });
    });
  }

  if (btnStart) btnStart.addEventListener('click', () => void handleStart());

  // =====================================================================
  // КНОПКА «ОСТАНОВИТЬ»
  // =====================================================================

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      chrome.storage.local.set({ crm_sync_command: 'stop' });
    });
  }

  // =====================================================================
  // CSV ЭКСПОРТ — две колонки: Profile URL | Full Name
  // =====================================================================

  /**
   * Генерирует CSV и запускает скачивание.
   * Колонка A: Profile URL
   * Колонка B: Full Name
   *
   * BOM (\uFEFF) — Excel открывает UTF-8 без настройки.
   * Расширяемо: раскомментировать строки для title/company/location.
   */
  function downloadCSV(contacts) {
    if (!contacts || contacts.length === 0) return;

    // Экранирование значения для CSV
    const esc = v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };

    const headers = ['Profile URL', 'Full Name'];
    // Будущие поля: headers.push('Title', 'Company', 'Location');

    const rows = [
      headers.map(esc).join(','),
      ...contacts.map(c => [
        esc(c.profileUrl ?? ''),
        esc(c.fullName   ?? '')
        // Будущие поля: esc(c.title), esc(c.company), esc(c.location)
      ].join(','))
    ];

    const csv  = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href:     url,
      download: `linkedin_contacts_${new Date().toISOString().slice(0, 10)}.csv`,
      style:    'display:none'
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  if (btnCSV) {
    btnCSV.addEventListener('click', () => {
      chrome.storage.local.get(['crm_contacts'], data => {
        const contacts = data.crm_contacts || [];
        if (!contacts.length) {
          alert('Нет контактов. Дождитесь завершения синхронизации.');
          return;
        }
        downloadCSV(contacts);
      });
    });
  }

  // =====================================================================
  // ПОИСК: ОТРАСЛИ
  // =====================================================================

  const INDUSTRY_OPTIONS = [
    { id: 'finance',         label: 'Финансы' },
    { id: 'consulting',      label: 'Консалтинг' },
    { id: 'tech',            label: 'Технологии' },
    { id: 'ai_ml',           label: 'AI / ML' },
    { id: 'healthcare',      label: 'Медицина' },
    { id: 'energy',          label: 'Энергетика' },
    { id: 'consumer',        label: 'Потребительский' },
    { id: 'industrial',      label: 'Промышленность' },
    { id: 'real_estate',     label: 'Недвижимость' },
    { id: 'media',           label: 'Медиа' },
    { id: 'education',       label: 'Образование' },
    { id: 'venture_capital', label: 'Венчур' },
    { id: 'government',      label: 'Госсектор' },
    { id: 'other',           label: 'Другое' }
  ];

  const industryRoot  = document.getElementById('industryTags');
  const keywordsInput = document.getElementById('searchKeywords');

  if (industryRoot) {
    INDUSTRY_OPTIONS.forEach(({ id, label }) => {
      const wrap  = document.createElement('label');
      wrap.className = 'tag-select__item';

      const input = Object.assign(document.createElement('input'), {
        type: 'checkbox', className: 'tag-select__input', value: id
      });
      input.setAttribute('data-industry', id);

      const pill = Object.assign(document.createElement('span'), {
        className: 'tag-select__pill', textContent: label
      });

      wrap.append(input, pill);
      industryRoot.appendChild(wrap);
    });
  }

  function buildSearchPayload() {
    const industries = industryRoot
      ? Array.from(industryRoot.querySelectorAll('input:checked')).map(el => el.value)
      : [];
    return {
      schemaVersion: 1,
      keywords: { raw: keywordsInput?.value.trim() || '', semantic: null },
      industries
    };
  }

  const btnSearch = document.getElementById('btnSearch');
  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      console.log('[CRM Dashboard] Search payload:', buildSearchPayload());
      // TODO (этап 4): отправить на FastAPI
    });
  }

})();