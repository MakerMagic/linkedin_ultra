/**
 * dashboard.js — LinkedIn CRM v2.1
 *
 * Новое:
 *   1. HELP_VIDEO_URL — вставьте сюда ссылку на видео-инструкцию split screen
 *   2. Кнопка "?" открывает/закрывает popover с видео (click toggle + Escape)
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // 👉 ВСТАВЬТЕ СЮДА ССЫЛКУ НА ВИДЕО-ИНСТРУКЦИЮ ПО SPLIT SCREEN
  //    Формат: прямая ссылка на .mp4 файл или совместимое видео
  //    id видео-элемента в HTML: "w4m9qx"
  const HELP_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  // ═══════════════════════════════════════════════════════════════

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15_000;

  const arc        = document.getElementById('progressArc');
  const pctEl      = document.getElementById('progressPercent');
  const statusEl   = document.getElementById('syncStatus');
  const countEl    = document.getElementById('syncCount');
  const etaEl      = document.getElementById('syncEta');
  const etaTextEl  = document.getElementById('syncEtaText');
  const btnStart   = document.getElementById('btnStart');
  const btnStop    = document.getElementById('btnStop');
  const btnCSV     = document.getElementById('btnDownloadCSV');
  const restartModal    = document.getElementById('restartModal');
  const btnModalConfirm = document.getElementById('btnModalConfirm');
  const btnModalCancel  = document.getElementById('btnModalCancel');
  const navButtons = document.querySelectorAll('.nav__item[data-nav]:not([disabled])');
  const panels     = document.querySelectorAll('.main-panel[data-panel]');

  // ── Split screen видео ────────────────────────────────────────────────
  // Устанавливаем src видео из константы HELP_VIDEO_URL
  const videoEl  = document.getElementById('w4m9qx');
  const videoSrc = document.getElementById('w4m9qxSrc');
  if (videoEl && videoSrc && HELP_VIDEO_URL && HELP_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    videoSrc.src = HELP_VIDEO_URL;
    videoEl.load();
  }

  // Кнопка "?" — toggle popover
  const helpBtn     = document.getElementById('splitscreenHelpBtn');
  const helpPopover = document.getElementById('splitscreenPopover');

  if (helpBtn && helpPopover) {
    helpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      const isOpen = !helpPopover.hidden;
      helpPopover.hidden = isOpen;
      helpBtn.setAttribute('aria-expanded', String(!isOpen));
      // Запускаем/останавливаем видео вместе с popover
      if (videoEl) {
        if (!isOpen) videoEl.play().catch(() => {});
        else videoEl.pause();
      }
    });

    // Закрываем по клику вне popover
    document.addEventListener('click', function (e) {
      if (!helpPopover.hidden && !helpPopover.contains(e.target) && e.target !== helpBtn) {
        helpPopover.hidden = true;
        helpBtn.setAttribute('aria-expanded', 'false');
        if (videoEl) videoEl.pause();
      }
    });

    // Закрываем по Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !helpPopover.hidden) {
        helpPopover.hidden = true;
        helpBtn.setAttribute('aria-expanded', 'false');
        if (videoEl) videoEl.pause();
      }
    });
  }

  // ── Навигация ──────────────────────────────────────────────────────────

  function setActiveView(viewId) {
    navButtons.forEach(btn => {
      const id = btn.getAttribute('data-nav'), active = id === viewId;
      btn.classList.toggle('nav__item--active', active);
      active ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
    });
    panels.forEach(p => p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === viewId));
    document.title = viewId === 'search' ? 'LinkedIn CRM — Поиск' : 'LinkedIn CRM — Синхронизация';
  }
  navButtons.forEach(btn => btn.addEventListener('click', function () { var id = btn.getAttribute('data-nav'); if (id) setActiveView(id); }));
  document.querySelectorAll('[data-go-sync]').forEach(el => el.addEventListener('click', function (e) { e.preventDefault(); setActiveView('sync'); }));

  // ── Кольцо ──────────────────────────────────────────────────────────────

  function setRingProgress(pct) {
    var p = Math.max(0, Math.min(100, pct));
    if (arc) { arc.style.strokeDasharray = String(CIRCUMFERENCE); arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100)); }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // ── ETA ─────────────────────────────────────────────────────────────────

  function formatEta(s) {
    if (s === null || s === undefined || s < 0) return null;
    if (s < 60) return '~' + Math.max(1, Math.round(s)) + ' сек';
    var m = Math.round(s / 60);
    if (m < 60) return '~' + m + ' мин';
    var h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? '~' + h + ' ч ' + rm + ' мин' : '~' + h + ' ч';
  }

  // ── State → UI ──────────────────────────────────────────────────────────

  function applyState(status, phase, count, percent, total, label, etaSeconds) {
    var running = status === 'running', isDone = status === 'done', hasContacts = count > 0;

    if (btnStart) {
      btnStart.disabled = running;
      btnStart.textContent = isDone ? 'Начать заново'
        : (status === 'stopped' && hasContacts ? 'Продолжить синхронизацию' : 'Начать синхронизацию');
    }

    if (btnStop) btnStop.disabled = !running;
    if (btnCSV)  btnCSV.disabled  = !hasContacts;

    if (countEl) countEl.textContent = label || (total ? count + ' / ' + total : String(count));

    if (etaEl && etaTextEl) {
      var showEta = running && total && count >= 10 && etaSeconds !== null;
      var etaStr  = showEta ? formatEta(etaSeconds) : null;
      if (etaStr) { etaTextEl.textContent = 'осталось ' + etaStr; etaEl.hidden = false; }
      else etaEl.hidden = true;
    }

    if (statusEl) {
      statusEl.textContent = ({
        idle:    'Ожидание запуска',
        running: 'Сбор контактов…',
        stopped: 'Остановлено',
        done:    'Завершено ✓',
        error:   'Ошибка — смотри консоль LinkedIn'
      })[status] || 'Ожидание запуска';
    }

    setRingProgress(status === 'idle' ? 0 : percent);
  }

  // ── Инициализация ────────────────────────────────────────────────────────

  var ALL_KEYS = ['crm_sync_status','crm_sync_phase','crm_sync_count','crm_sync_percent','crm_sync_total','crm_sync_label','crm_sync_eta_seconds','crm_heartbeat'];

  function loadAndApplyState() {
    chrome.storage.local.get(ALL_KEYS, function (data) {
      var status = data.crm_sync_status || 'idle';
      if (status === 'running' && Date.now() - (data.crm_heartbeat || 0) > HEARTBEAT_STALE_MS) {
        status = 'idle';
        chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
      }
      applyState(status, data.crm_sync_phase||'', data.crm_sync_count||0, data.crm_sync_percent||0, data.crm_sync_total||null, data.crm_sync_label||'', data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null);
    });
  }
  loadAndApplyState();

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    var relevant = ['crm_sync_status','crm_sync_phase','crm_sync_count','crm_sync_percent','crm_sync_total','crm_sync_label','crm_sync_eta_seconds'];
    if (!relevant.some(function (k) { return k in changes; })) return;
    chrome.storage.local.get(ALL_KEYS, function (data) {
      applyState(data.crm_sync_status||'idle', data.crm_sync_phase||'', data.crm_sync_count||0, data.crm_sync_percent||0, data.crm_sync_total||null, data.crm_sync_label||'', data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null);
    });
  });

  // ── Modal ────────────────────────────────────────────────────────────────

  function showModal() { if (restartModal) restartModal.hidden = false; }
  function hideModal() { if (restartModal) restartModal.hidden = true; }
  if (restartModal) restartModal.addEventListener('click', function (e) { if (e.target === restartModal) hideModal(); });
  if (btnModalCancel) btnModalCancel.addEventListener('click', hideModal);
  if (btnModalConfirm) {
    btnModalConfirm.addEventListener('click', async function () { hideModal(); await performRestart(); });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && restartModal && !restartModal.hidden) hideModal();
  });

  // ── Restart ──────────────────────────────────────────────────────────────

  async function performRestart() {
    if (statusEl) statusEl.textContent = 'Сброс данных…';
    if (btnStart) btnStart.disabled = true;
    await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'RESTART_SYNC' }, function (response) {
        if (chrome.runtime.lastError) console.warn('[CRM] RESTART_SYNC:', chrome.runtime.lastError.message);
        resolve();
      });
    });
    if (statusEl) statusEl.textContent = 'Перезагрузка LinkedIn…';
    await new Promise(function (r) { setTimeout(r, 4000); });
    await handleStart();
  }

  // ── Кнопки ───────────────────────────────────────────────────────────────

  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Подключение к LinkedIn…';
    var ok = await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT' }, function (response) {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(response && response.ok !== false);
      });
    });
    if (!ok) {
      if (statusEl) statusEl.textContent = 'Ошибка: откройте вкладку LinkedIn Connections';
      if (btnStart) btnStart.disabled = false;
      return;
    }
    chrome.storage.local.set({ crm_sync_command: 'start', crm_sync_status: 'running' });
  }

  if (btnStart) {
    btnStart.addEventListener('click', function () {
      chrome.storage.local.get(['crm_sync_status'], function (data) {
        if ((data.crm_sync_status || 'idle') === 'done') showModal();
        else handleStart();
      });
    });
  }

  if (btnStop) btnStop.addEventListener('click', function () { chrome.storage.local.set({ crm_sync_command: 'stop' }); });

  // ── TSV export ───────────────────────────────────────────────────────────

  function downloadTSV(contacts) {
    if (!contacts || !contacts.length) return;
    function clean(v) { return String(v || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '); }
    var lines = [['Name','URL','Job Title','Company','School'].join('\t')].concat(
      contacts.map(function (c) {
        return [clean(c.fullName), clean(c.profileUrl), clean(c.jobTitle), clean(c.company), clean(c.school)].join('\t');
      })
    );
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = 'linkedin_contacts_' + new Date().toISOString().slice(0, 10) + '.tsv';
    a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  if (btnCSV) {
    btnCSV.addEventListener('click', function () {
      chrome.storage.local.get(['crm_contacts'], function (data) {
        var contacts = data.crm_contacts || [];
        if (!contacts.length) { alert('Нет контактов. Запустите синхронизацию.'); return; }
        downloadTSV(contacts);
      });
    });
  }

  // ── Поиск: отрасли ───────────────────────────────────────────────────────

  var INDUSTRY_OPTIONS = [
    {id:'finance',label:'Финансы'},{id:'consulting',label:'Консалтинг'},{id:'tech',label:'Технологии'},
    {id:'ai_ml',label:'AI / ML'},{id:'healthcare',label:'Медицина'},{id:'energy',label:'Энергетика'},
    {id:'consumer',label:'Потребительский'},{id:'industrial',label:'Промышленность'},{id:'real_estate',label:'Недвижимость'},
    {id:'media',label:'Медиа'},{id:'education',label:'Образование'},{id:'venture_capital',label:'Венчур'},
    {id:'government',label:'Госсектор'},{id:'other',label:'Другое'}
  ];
  var industryRoot  = document.getElementById('industryTags');
  var keywordsInput = document.getElementById('searchKeywords');
  if (industryRoot) {
    INDUSTRY_OPTIONS.forEach(function (opt) {
      var wrap  = document.createElement('label'); wrap.className = 'tag-select__item';
      var input = document.createElement('input'); input.type = 'checkbox'; input.className = 'tag-select__input'; input.value = opt.id; input.setAttribute('data-industry', opt.id);
      var pill  = document.createElement('span');  pill.className = 'tag-select__pill'; pill.textContent = opt.label;
      wrap.appendChild(input); wrap.appendChild(pill); industryRoot.appendChild(wrap);
    });
  }
  var btnSearch = document.getElementById('btnSearch');
  if (btnSearch) {
    btnSearch.addEventListener('click', function () {
      var industries = industryRoot ? Array.from(industryRoot.querySelectorAll('input:checked')).map(function (el) { return el.value; }) : [];
      console.log('[CRM Dashboard] Search payload:', { schemaVersion: 1, keywords: { raw: keywordsInput ? keywordsInput.value.trim() : '', semantic: null }, industries: industries });
    });
  }

})();