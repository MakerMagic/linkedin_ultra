/**
 * dashboard.js — LinkedIn CRM v0.6
 * Единственное изменение относительно v0.5:
 *   Счётчик теперь показывает "Собрано: 234 / 500" если total известен.
 */
(function () {
  'use strict';

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15_000;

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

  function applyState(status, phase, count, percent, total) {
    const running     = status === 'running';
    const hasContacts = count > 0;

    if (btnStart) btnStart.disabled = running;
    if (btnStop)  btnStop.disabled  = !running;
    if (btnCSV)   btnCSV.disabled   = !hasContacts;

    // Счётчик: "234" или "234 / 500"
    if (countEl) {
      countEl.textContent = (total && total > 0)
        ? `${count} / ${total}`
        : String(count);
    }

    // Статус
    let statusText;
    if (status === 'running') {
      statusText = phase === 'collecting' ? 'Сбор контактов…' : 'Скроллинг страницы…';
    } else {
      statusText = { idle: 'Ожидание запуска', done: 'Завершено ✓', stopped: 'Остановлено', error: 'Ошибка' }[status] || 'Ожидание запуска';
    }
    if (statusEl) statusEl.textContent = statusText;

    // Кольцо
    setRingProgress(status === 'idle' ? 0 : percent);

    // Текст кнопки «Начать»
    if (btnStart) {
      btnStart.textContent =
        hasContacts && !running && status === 'stopped'
          ? 'Продолжить синхронизацию'
          : 'Начать синхронизацию';
    }
  }

  // =====================================================================
  // ИНИЦИАЛИЗАЦИЯ — читаем storage + heartbeat-проверка
  // =====================================================================

  async function loadAndApplyState() {
    return new Promise(resolve => {
      chrome.storage.local.get(
        ['crm_sync_status', 'crm_sync_phase', 'crm_sync_count',
         'crm_sync_percent', 'crm_sync_total', 'crm_heartbeat'],
        data => {
          let status  = data.crm_sync_status  || 'idle';
          const phase   = data.crm_sync_phase   || '';
          const count   = data.crm_sync_count   || 0;
          const percent = data.crm_sync_percent  || 0;
          const total   = data.crm_sync_total    || null;
          const hb      = data.crm_heartbeat    || 0;

          // Зависший running → сбрасываем
          if (status === 'running' && Date.now() - hb > HEARTBEAT_STALE_MS) {
            status = 'idle';
            chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
          }

          applyState(status, phase, count, percent, total);
          resolve();
        }
      );
    });
  }

  void loadAndApplyState();

  // Live-обновления
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = ['crm_sync_status', 'crm_sync_phase', 'crm_sync_count', 'crm_sync_percent', 'crm_sync_total'];
    if (!keys.some(k => k in changes)) return;

    chrome.storage.local.get(keys, data => applyState(
      data.crm_sync_status  || 'idle',
      data.crm_sync_phase   || '',
      data.crm_sync_count   || 0,
      data.crm_sync_percent || 0,
      data.crm_sync_total   || null
    ));
  });

  // =====================================================================
  // КНОПКИ
  // =====================================================================

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

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      // Пишем stop — content.js увидит через onChanged и отменит токен
      chrome.storage.local.set({ crm_sync_command: 'stop' });
    });
  }

  // =====================================================================
  // CSV ЭКСПОРТ
  // =====================================================================

  function downloadCSV(contacts) {
    if (!contacts?.length) return;

    const esc = v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const rows = [
      ['Profile URL', 'Full Name'].map(esc).join(','),
      ...contacts.map(c => [esc(c.profileUrl ?? ''), esc(c.fullName ?? '')].join(','))
    ];

    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `linkedin_contacts_${new Date().toISOString().slice(0, 10)}.csv`,
      style: 'display:none'
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
        if (!contacts.length) { alert('Нет контактов. Запустите синхронизацию.'); return; }
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