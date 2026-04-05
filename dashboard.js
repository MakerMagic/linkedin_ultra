/**
 * dashboard.js — LinkedIn CRM v1.3
 *
 * Исправлено:
 *   1. Экспорт → TSV (tab-separated) вместо HTML XLS.
 *      Tab гарантированно не встречается в именах и URL,
 *      поэтому Excel открывает файл с двумя колонками на ЛЮБОЙ локали.
 *      Колонки: A = Name, B = URL (как в ТЗ — имя первым).
 *
 *   2. ETA не показывается пока собрано < 10 контактов.
 *      Было: показывалось после 2 батчей (может быть < 10 контактов).
 *      Стало: проверка count >= 10 в applyState.
 */
(function () {
  'use strict';

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15_000;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const navButtons = document.querySelectorAll('.nav__item[data-nav]:not([disabled])');
  const panels     = document.querySelectorAll('.main-panel[data-panel]');

  const arc        = document.getElementById('progressArc');
  const pctEl      = document.getElementById('progressPercent');
  const statusEl   = document.getElementById('syncStatus');
  const countEl    = document.getElementById('syncCount');
  const etaEl      = document.getElementById('syncEta');
  const etaTextEl  = document.getElementById('syncEtaText');
  const btnStart   = document.getElementById('btnStart');
  const btnStop    = document.getElementById('btnStop');
  const btnCSV     = document.getElementById('btnDownloadCSV');

  // ── Навигация ─────────────────────────────────────────────────────────────

  function setActiveView(viewId) {
    navButtons.forEach(btn => {
      const id = btn.getAttribute('data-nav');
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

  // ── Кольцо прогресса ──────────────────────────────────────────────────────

  function setRingProgress(pct) {
    const p = Math.max(0, Math.min(100, pct));
    if (arc) {
      arc.style.strokeDasharray  = String(CIRCUMFERENCE);
      arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100));
    }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // ── ETA форматирование ────────────────────────────────────────────────────

  /**
   * Форматирует секунды в читаемую строку.
   * Примеры: "менее минуты", "~3 мин", "~1 ч 12 мин"
   */
  function formatEta(seconds) {
    if (seconds === null || seconds === undefined || seconds < 0) return null;
    if (seconds < 60)  return 'менее минуты';
    const mins = Math.round(seconds / 60);
    if (mins < 60)     return `~${mins} мин`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `~${h} ч ${m} мин` : `~${h} ч`;
  }

  // ── Применение состояния ──────────────────────────────────────────────────

  function applyState(status, phase, count, percent, total, label, etaSeconds) {
    const running     = status === 'running';
    const hasContacts = count > 0;

    if (btnStart) btnStart.disabled = running;
    if (btnStop)  btnStop.disabled  = !running;
    if (btnCSV)   btnCSV.disabled   = !hasContacts;

    // Счётчик: "Собрано 347 из 1234"
    if (countEl) {
      countEl.textContent = label || (total ? `${count} / ${total}` : String(count));
    }

    // ETA: показываем только если:
    //   - идёт синхронизация
    //   - total известен
    //   - собрано >= 10 контактов (до этого данных для расчёта недостаточно)
    if (etaEl && etaTextEl) {
      const showEta = running && total && count >= 10;
      const etaStr  = showEta ? formatEta(etaSeconds) : null;
      if (etaStr) {
        etaTextEl.textContent = `Осталось ${etaStr}`;
        etaEl.hidden = false;
      } else {
        etaEl.hidden = true;
      }
    }

    // Статус
    let statusText;
    if (status === 'running') {
      statusText = 'Сбор контактов…';
    } else {
      statusText = ({
        idle:    'Ожидание запуска',
        done:    'Завершено ✓',
        stopped: 'Остановлено',
        error:   'Ошибка — смотри консоль LinkedIn'
      })[status] || 'Ожидание запуска';
    }
    if (statusEl) statusEl.textContent = statusText;

    // Кольцо
    setRingProgress(status === 'idle' ? 0 : percent);

    // Текст кнопки
    if (btnStart) {
      btnStart.textContent = (hasContacts && !running && status === 'stopped')
        ? 'Продолжить синхронизацию'
        : 'Начать синхронизацию';
    }
  }

  // ── Инициализация ─────────────────────────────────────────────────────────

  const ALL_KEYS = [
    'crm_sync_status', 'crm_sync_phase', 'crm_sync_count',
    'crm_sync_percent', 'crm_sync_total', 'crm_sync_label',
    'crm_sync_eta_seconds', 'crm_heartbeat'
  ];

  async function loadAndApplyState() {
    return new Promise(resolve => {
      chrome.storage.local.get(ALL_KEYS, data => {
        let status    = data.crm_sync_status     || 'idle';
        const phase   = data.crm_sync_phase      || '';
        const count   = data.crm_sync_count      || 0;
        const percent = data.crm_sync_percent    || 0;
        const total   = data.crm_sync_total      || null;
        const label   = data.crm_sync_label      || '';
        const eta     = data.crm_sync_eta_seconds ?? null;
        const hb      = data.crm_heartbeat       || 0;

        // Зависший running-статус — сбрасываем
        if (status === 'running' && Date.now() - hb > HEARTBEAT_STALE_MS) {
          status = 'idle';
          chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
        }

        applyState(status, phase, count, percent, total, label, eta);
        resolve();
      });
    });
  }

  void loadAndApplyState();

  // Live-обновления от content.js
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = [
      'crm_sync_status', 'crm_sync_phase', 'crm_sync_count',
      'crm_sync_percent', 'crm_sync_total', 'crm_sync_label', 'crm_sync_eta_seconds'
    ];
    if (!relevant.some(k => k in changes)) return;

    chrome.storage.local.get(ALL_KEYS, data => applyState(
      data.crm_sync_status     || 'idle',
      data.crm_sync_phase      || '',
      data.crm_sync_count      || 0,
      data.crm_sync_percent    || 0,
      data.crm_sync_total      || null,
      data.crm_sync_label      || '',
      data.crm_sync_eta_seconds ?? null
    ));
  });

  // ── Кнопки управления ─────────────────────────────────────────────────────

  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Подключение к LinkedIn…';

    const ok = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT' }, response => {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(response?.ok !== false);
      });
    });

    if (!ok) {
      if (statusEl) statusEl.textContent = 'Ошибка: откройте вкладку LinkedIn Connections';
      if (btnStart) btnStart.disabled = false;
      return;
    }

    chrome.storage.local.set({ crm_sync_command: 'start', crm_sync_status: 'running' });
  }

  if (btnStart) btnStart.addEventListener('click', () => void handleStart());
  if (btnStop)  btnStop.addEventListener('click', () => chrome.storage.local.set({ crm_sync_command: 'stop' }));

  // ── Экспорт: TSV (Tab-Separated Values) ──────────────────────────────────
  //
  // Почему TSV, а не CSV и не XLS:
  //   - CSV с запятой: не работает в Excel на локалях с разделителем ";"
  //   - HTML XLS: не всегда открывается с колонками в старых версиях Excel
  //   - TSV: символ Tab никогда не встречается в именах людей и LinkedIn URL.
  //     Excel открывает .tsv с правильными колонками на ЛЮБОЙ локали без
  //     дополнительных настроек. Это самый надёжный формат.
  //
  // Колонки (порядок из ТЗ):
  //   A = Name (полное имя)
  //   B = URL  (ссылка на профиль)

  function downloadTSV(contacts) {
    if (!contacts?.length) return;

    // Убираем табы из значений (на случай если вдруг есть в имени)
    const clean = v => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');

    const lines = [
      // Заголовок: Name\tURL
      ['Name', 'URL'].join('\t'),
      // Данные: имя первым, URL вторым
      ...contacts.map(c => [clean(c.fullName), clean(c.profileUrl)].join('\t'))
    ];

    // BOM (0xEF 0xBB 0xBF) — Excel правильно распознаёт UTF-8
    const content = '\uFEFF' + lines.join('\r\n');
    const blob    = new Blob([content], { type: 'text/tab-separated-values;charset=utf-8' });
    const url     = URL.createObjectURL(blob);

    const a = Object.assign(document.createElement('a'), {
      href:     url,
      download: `linkedin_contacts_${new Date().toISOString().slice(0, 10)}.tsv`,
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
          alert('Нет контактов. Запустите синхронизацию.');
          return;
        }
        downloadTSV(contacts);
      });
    });
  }

  // ── Поиск: отрасли ────────────────────────────────────────────────────────

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
      const wrap = document.createElement('label');
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

  const btnSearch = document.getElementById('btnSearch');
  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      const industries = industryRoot
        ? Array.from(industryRoot.querySelectorAll('input:checked')).map(el => el.value)
        : [];
      console.log('[CRM Dashboard] Search payload:', {
        schemaVersion: 1,
        keywords: { raw: keywordsInput?.value.trim() || '', semantic: null },
        industries
      });
      // TODO (этап 4): отправить на FastAPI
    });
  }

})();