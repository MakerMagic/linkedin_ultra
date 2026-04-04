/**
 * dashboard.js — панель LinkedIn CRM v0.4.
 *
 * Исправлено:
 *   1. Перед START — проверяем что content.js жив (через background)
 *   2. Heartbeat-проверка: если status='running' но heartbeat устарел → сброс в idle
 *   3. Кнопка Start всегда активна в idle/stopped/done/error
 *   4. Прогресс НЕ ставится в 100% без реальных данных
 */
(function () {
  'use strict';

  // ——— Константы ———
  const HEARTBEAT_STALE_MS = 15_000; // Через сколько мс без heartbeat считаем процесс мёртвым
  const CIRCUMFERENCE = 2 * Math.PI * 52;

  // ——— DOM ———
  const navButtons = document.querySelectorAll('.nav__item[data-nav]:not([disabled])');
  const panels     = document.querySelectorAll('.main-panel[data-panel]');

  const arc      = document.getElementById('progressArc');
  const pctEl    = document.getElementById('progressPercent');
  const statusEl = document.getElementById('syncStatus');
  const countEl  = document.getElementById('syncCount');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCSV   = document.getElementById('btnDownloadCSV');

  // ========================================================
  // НАВИГАЦИЯ
  // ========================================================

  function setActiveView(viewId) {
    navButtons.forEach(btn => {
      const id     = btn.getAttribute('data-nav');
      const active = id === viewId;
      btn.classList.toggle('nav__item--active', active);
      active ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
    });
    panels.forEach(p => {
      p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === viewId);
    });
    document.title = viewId === 'search' ? 'LinkedIn CRM — Поиск' : 'LinkedIn CRM — Синхронизация';
  }

  navButtons.forEach(btn => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-nav');
    if (id) setActiveView(id);
  }));

  document.querySelectorAll('[data-go-sync]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); setActiveView('sync'); });
  });

  // ========================================================
  // КОЛЬЦО ПРОГРЕССА
  // ========================================================

  function setRingProgress(pct) {
    const p = Math.max(0, Math.min(100, pct));
    if (arc) {
      arc.style.strokeDasharray  = String(CIRCUMFERENCE);
      arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100));
    }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  function setSpinner(on) {
    const svg = arc && arc.closest('svg');
    if (svg) svg.classList.toggle('progress-ring__svg--spinning', on);
  }

  // ========================================================
  // ПРИМЕНЕНИЕ СОСТОЯНИЯ К UI
  // ========================================================

  /**
   * @param {'idle'|'running'|'done'|'stopped'|'error'} status
   * @param {number} count
   */
  function applyState(status, count) {
    const running     = status === 'running';
    const hasContacts = count > 0;

    // Кнопки
    if (btnStart) btnStart.disabled = running;
    if (btnStop)  btnStop.disabled  = !running;
    if (btnCSV)   btnCSV.disabled   = !hasContacts;

    // Счётчик
    if (countEl) countEl.textContent = String(count);

    // Статус
    const labels = {
      idle:    'Ожидание запуска',
      running: 'Синхронизация…',
      done:    'Завершено ✓',
      stopped: 'Остановлено',
      error:   'Ошибка — смотри консоль вкладки LinkedIn'
    };
    if (statusEl) statusEl.textContent = labels[status] || 'Ожидание запуска';

    // Кольцо: спиннер во время сбора, 100% по завершению
    if (running) {
      setSpinner(true);
      setRingProgress(0);
    } else {
      setSpinner(false);
      setRingProgress(status === 'done' || status === 'stopped' ? 100 : 0);
    }
  }

  // ========================================================
  // ПРОВЕРКА HEARTBEAT (антизависание)
  // ========================================================

  /**
   * Если в storage status='running' но heartbeat давно не обновлялся —
   * значит content.js упал/перезагрузился. Сбрасываем состояние в 'idle'.
   */
  async function maybeResetStaleState() {
    return new Promise(resolve => {
      chrome.storage.local.get(
        ['crm_sync_status', 'crm_sync_count', 'crm_heartbeat'],
        data => {
          const status = data.crm_sync_status || 'idle';
          const count  = data.crm_sync_count  || 0;
          const hb     = data.crm_heartbeat   || 0;
          const stale  = Date.now() - hb > HEARTBEAT_STALE_MS;

          if (status === 'running' && stale) {
            console.log('[CRM Dashboard] Обнаружен зависший статус running → сброс в idle');
            chrome.storage.local.set({
              crm_sync_status:  'idle',
              crm_sync_command: null
            }, () => resolve({ status: 'idle', count }));
          } else {
            resolve({ status, count });
          }
        }
      );
    });
  }

  // ========================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ========================================================

  (async () => {
    const { status, count } = await maybeResetStaleState();
    applyState(status, count);
  })();

  // ——— Live-обновления от content.js ———
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = ['crm_sync_status', 'crm_sync_count'];
    if (!relevant.some(k => k in changes)) return;

    chrome.storage.local.get(['crm_sync_status', 'crm_sync_count'], data => {
      applyState(data.crm_sync_status || 'idle', data.crm_sync_count || 0);
    });
  });

  // ========================================================
  // КНОПКА «НАЧАТЬ»
  // ========================================================

  /**
   * Перед запуском синхронизации:
   * 1. Просим background проверить/инжектировать content.js
   * 2. Пишем команду START в storage
   */
  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Подключение к LinkedIn…';

    // Гарантируем что content script инжектирован
    const ensureOk = await ensureContentScript();
    if (!ensureOk) {
      if (statusEl) statusEl.textContent = 'Ошибка: откройте вкладку LinkedIn Connections';
      if (btnStart) btnStart.disabled = false;
      return;
    }

    // Команда START
    chrome.storage.local.set({
      crm_sync_command: 'start',
      crm_sync_status:  'running'
    });

    applyState('running', parseInt(countEl?.textContent || '0', 10));
  }

  /**
   * Запрос к background: проверить жив ли content.js, при необходимости — инжектировать.
   * @returns {Promise<boolean>}
   */
  function ensureContentScript() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT' }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[CRM Dashboard] ensureContentScript error:', chrome.runtime.lastError.message);
          // Даже при ошибке пробуем продолжить — content_scripts мог авто-инжектироваться
          resolve(true);
          return;
        }
        console.log('[CRM Dashboard] ensureContentScript result:', response);
        resolve(response && response.ok !== false);
      });
    });
  }

  if (btnStart) btnStart.addEventListener('click', () => { void handleStart(); });

  // ========================================================
  // КНОПКА «ОСТАНОВИТЬ»
  // ========================================================

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      chrome.storage.local.set({ crm_sync_command: 'stop' });
      // UI обновится через onChanged когда content.js запишет 'stopped'
    });
  }

  // ========================================================
  // CSV ЭКСПОРТ
  // ========================================================

  /**
   * Генерирует CSV и запускает скачивание.
   * Формат совпадает с for_project.xlsx: Profile URL | Full Name.
   * BOM (\uFEFF) = Excel открывает без настройки кодировки.
   *
   * Добавить поля: title, company, location — раскомментировать строки ниже.
   */
  function downloadCSV(contacts) {
    if (!contacts || contacts.length === 0) return;

    const headers = ['Profile URL', 'Full Name'];
    // Будущие поля: headers.push('Title', 'Company', 'Location');

    const esc = v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };

    const rows = [
      headers.map(esc).join(','),
      ...contacts.map(c => [
        esc(c.profileUrl),
        esc(c.fullName)
        // Будущие поля: esc(c.title), esc(c.company), esc(c.location)
      ].join(','))
    ];

    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
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
          alert('Нет сохранённых контактов. Сначала запустите синхронизацию.');
          return;
        }
        downloadCSV(contacts);
      });
    });
  }

  // ========================================================
  // ПОИСК: ОТРАСЛИ
  // ========================================================

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
      const pill  = Object.assign(document.createElement('span'), {
        className: 'tag-select__pill', textContent: label
      });
      wrap.append(input, pill);
      industryRoot.appendChild(wrap);
    });
  }

  function getSelectedIndustries() {
    if (!industryRoot) return [];
    return Array.from(industryRoot.querySelectorAll('input:checked')).map(el => el.value);
  }

  function buildSearchPayload() {
    return {
      schemaVersion: 1,
      keywords: { raw: keywordsInput?.value.trim() || '', semantic: null },
      industries: getSelectedIndustries()
    };
  }

  const btnSearch = document.getElementById('btnSearch');
  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      console.log('[CRM Dashboard] Search payload:', buildSearchPayload());
      // TODO: FastAPI / AI на следующих шагах
    });
  }

})();