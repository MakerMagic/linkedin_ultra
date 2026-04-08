/**
 * dashboard.js — LinkedIn CRM v2.3
 *
 * UI полностью на английском.
 * Вкладки: Sync | Search (с отраслями) | Help (FAQ + видео) | Contacts (soon)
 * CSV: Name, URL, Job Title, Company, School, Major
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // 👉 DEMO VIDEO — вкладка Help (с controls, можно поставить на паузу)
  const DEMO_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';

  // 👉 HELP VIDEO — split screen popover (без controls, autoplay loop muted)
  //    id элемента в HTML: "w4m9qx"
  const HELP_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  // ═══════════════════════════════════════════════════════════════════════

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15000;

  // ── DOM refs ──────────────────────────────────────────────────────────
  var arc        = document.getElementById('progressArc');
  var pctEl      = document.getElementById('progressPercent');
  var statusEl   = document.getElementById('syncStatus');
  var countEl    = document.getElementById('syncCount');
  var etaEl      = document.getElementById('syncEta');
  var etaTextEl  = document.getElementById('syncEtaText');
  var btnStart   = document.getElementById('btnStart');
  var btnStop    = document.getElementById('btnStop');
  var btnCSV     = document.getElementById('btnDownloadCSV');
  var restartModal    = document.getElementById('restartModal');
  var btnModalConfirm = document.getElementById('btnModalConfirm');
  var btnModalCancel  = document.getElementById('btnModalCancel');
  var navButtons = document.querySelectorAll('.nav__item[data-nav]:not([disabled])');
  var panels     = document.querySelectorAll('.main-panel[data-panel]');

  // ── Demo video (Help tab) ──────────────────────────────────────────────
  var demoVideo    = document.getElementById('demoVideo');
  var demoVideoSrc = document.getElementById('demoVideoSrc');
  if (demoVideo && demoVideoSrc && DEMO_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    demoVideoSrc.src = DEMO_VIDEO_URL;
    demoVideo.load();
  }

  // ── Split screen popover video ─────────────────────────────────────────
  var helpVideoEl  = document.getElementById('w4m9qx');
  var helpVideoSrc = document.getElementById('w4m9qxSrc');
  if (helpVideoEl && helpVideoSrc && HELP_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    helpVideoSrc.src = HELP_VIDEO_URL;
    helpVideoEl.load();
  }

  var helpBtn     = document.getElementById('splitscreenHelpBtn');
  var helpPopover = document.getElementById('splitscreenPopover');
  if (helpBtn && helpPopover) {
    helpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = !helpPopover.hidden;
      helpPopover.hidden = isOpen;
      helpBtn.setAttribute('aria-expanded', String(!isOpen));
      if (helpVideoEl) { if (!isOpen) helpVideoEl.play().catch(function(){}); else helpVideoEl.pause(); }
    });
    document.addEventListener('click', function (e) {
      if (!helpPopover.hidden && !helpPopover.contains(e.target) && e.target !== helpBtn) {
        helpPopover.hidden = true;
        helpBtn.setAttribute('aria-expanded', 'false');
        if (helpVideoEl) helpVideoEl.pause();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !helpPopover.hidden) {
        helpPopover.hidden = true;
        helpBtn.setAttribute('aria-expanded', 'false');
        if (helpVideoEl) helpVideoEl.pause();
      }
    });
  }

  // ── FAQ accordion ──────────────────────────────────────────────────────
  document.querySelectorAll('.faq__question').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      var answerId = btn.getAttribute('aria-controls');
      var answer   = document.getElementById(answerId);

      // Закрываем остальные
      document.querySelectorAll('.faq__question[aria-expanded="true"]').forEach(function (other) {
        if (other === btn) return;
        other.setAttribute('aria-expanded', 'false');
        var otherA = document.getElementById(other.getAttribute('aria-controls'));
        if (otherA) otherA.hidden = true;
      });

      btn.setAttribute('aria-expanded', String(!expanded));
      if (answer) answer.hidden = expanded;
    });
  });

  // ── Navigation ─────────────────────────────────────────────────────────
  function setActiveView(viewId) {
    navButtons.forEach(function (btn) {
      var id = btn.getAttribute('data-nav'), active = id === viewId;
      btn.classList.toggle('nav__item--active', active);
      active ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
    });
    panels.forEach(function (p) {
      p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === viewId);
    });
    var titles = { sync:'LinkedIn CRM — Sync', search:'LinkedIn CRM — Search', help:'LinkedIn CRM — Help' };
    document.title = titles[viewId] || 'LinkedIn CRM';
  }
  navButtons.forEach(function (btn) {
    btn.addEventListener('click', function () { var id = btn.getAttribute('data-nav'); if (id) setActiveView(id); });
  });
  document.querySelectorAll('[data-go-sync]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); setActiveView('sync'); });
  });

  // ── Progress ring ──────────────────────────────────────────────────────
  function setRingProgress(pct) {
    var p = Math.max(0, Math.min(100, pct));
    if (arc) { arc.style.strokeDasharray = String(CIRCUMFERENCE); arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100)); }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // ── ETA ────────────────────────────────────────────────────────────────
  function formatEta(s) {
    if (s === null || s === undefined || s < 0) return null;
    if (s < 60) return '~' + Math.max(1, Math.round(s)) + 's';
    var m = Math.round(s / 60);
    if (m < 60) return '~' + m + ' min';
    var h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? '~' + h + 'h ' + rm + 'min' : '~' + h + 'h';
  }

  // ── State → UI ─────────────────────────────────────────────────────────
  function applyState(status, phase, count, percent, total, label, etaSeconds) {
    var running = status === 'running';
    var isDone  = status === 'done';
    var hasContacts = count > 0;

    if (btnStart) {
      btnStart.disabled = running;
      btnStart.textContent = isDone ? 'Start Over'
        : (status === 'stopped' && hasContacts ? 'Resume Sync' : 'Start Sync');
    }
    if (btnStop) btnStop.disabled = !running;
    if (btnCSV)  btnCSV.disabled  = !hasContacts;

    if (countEl) {
      // Метка "Collected X of Y" приходит из content.js (crm_sync_label)
      // но там текст на русском — генерируем свой английский
      if (label && label.startsWith('Собрано')) {
        var m = label.match(/(\d+)\s*из\s*(\d+)/);
        var m2 = label.match(/Собрано\s+(\d+)$/);
        if (m) countEl.textContent = 'Collected ' + m[1] + ' of ' + m[2];
        else if (m2) countEl.textContent = 'Collected ' + m2[1];
        else countEl.textContent = label;
      } else {
        countEl.textContent = label || (total ? 'Collected ' + count + ' of ' + total : String(count));
      }
    }

    if (etaEl && etaTextEl) {
      var showEta = running && total && count >= 10 && etaSeconds !== null;
      var etaStr  = showEta ? formatEta(etaSeconds) : null;
      if (etaStr) { etaTextEl.textContent = etaStr + ' left'; etaEl.hidden = false; }
      else etaEl.hidden = true;
    }

    if (statusEl) {
      statusEl.textContent = ({
        idle:    'Waiting to start',
        running: 'Syncing…',
        stopped: 'Stopped',
        done:    'Completed ✓',
        error:   'Error — check LinkedIn console'
      })[status] || 'Waiting to start';
    }

    setRingProgress(status === 'idle' ? 0 : percent);
  }

  // ── Init ───────────────────────────────────────────────────────────────
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
    var rel = ['crm_sync_status','crm_sync_phase','crm_sync_count','crm_sync_percent','crm_sync_total','crm_sync_label','crm_sync_eta_seconds'];
    if (!rel.some(function (k) { return k in changes; })) return;
    chrome.storage.local.get(ALL_KEYS, function (data) {
      applyState(data.crm_sync_status||'idle', data.crm_sync_phase||'', data.crm_sync_count||0, data.crm_sync_percent||0, data.crm_sync_total||null, data.crm_sync_label||'', data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null);
    });
  });

  // ── Modal ──────────────────────────────────────────────────────────────
  function showModal() { if (restartModal) restartModal.hidden = false; }
  function hideModal() { if (restartModal) restartModal.hidden = true; }
  if (restartModal) restartModal.addEventListener('click', function (e) { if (e.target === restartModal) hideModal(); });
  if (btnModalCancel) btnModalCancel.addEventListener('click', hideModal);
  if (btnModalConfirm) btnModalConfirm.addEventListener('click', async function () { hideModal(); await performRestart(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && restartModal && !restartModal.hidden) hideModal(); });

  // ── Restart ────────────────────────────────────────────────────────────
  async function performRestart() {
    if (statusEl) statusEl.textContent = 'Resetting…';
    if (btnStart) btnStart.disabled = true;
    await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'RESTART_SYNC' }, function (r) {
        if (chrome.runtime.lastError) console.warn('[CRM] RESTART_SYNC:', chrome.runtime.lastError.message);
        resolve();
      });
    });
    if (statusEl) statusEl.textContent = 'Reloading LinkedIn…';
    await new Promise(function (r) { setTimeout(r, 4000); });
    await handleStart();
  }

  // ── Start ──────────────────────────────────────────────────────────────
  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Connecting to LinkedIn…';
    var ok = await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT' }, function (r) {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(r && r.ok !== false);
      });
    });
    if (!ok) {
      if (statusEl) statusEl.textContent = 'Error: open LinkedIn Connections tab';
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

  // ── CSV export (Name, URL, Job Title, Company, School, Major) ───────────
  function downloadTSV(contacts) {
    if (!contacts || !contacts.length) return;
    function clean(v) { return String(v || '').replace(/\t/g,' ').replace(/\r?\n/g,' '); }
    var lines = [['Name','URL','Job Title','Company','School','Major'].join('\t')].concat(
      contacts.map(function (c) {
        return [clean(c.fullName), clean(c.profileUrl), clean(c.jobTitle), clean(c.company), clean(c.school), clean(c.major)].join('\t');
      })
    );
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'linkedin_contacts_' + new Date().toISOString().slice(0,10) + '.tsv'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  if (btnCSV) {
    btnCSV.addEventListener('click', function () {
      chrome.storage.local.get(['crm_contacts'], function (data) {
        var contacts = data.crm_contacts || [];
        if (!contacts.length) { alert('No contacts yet. Start sync first.'); return; }
        downloadTSV(contacts);
      });
    });
  }

  // ── Search: industries ─────────────────────────────────────────────────
  var INDUSTRY_OPTIONS = [
    {id:'finance',label:'Finance'},{id:'consulting',label:'Consulting'},{id:'tech',label:'Technology'},
    {id:'ai_ml',label:'AI / ML'},{id:'healthcare',label:'Healthcare'},{id:'energy',label:'Energy'},
    {id:'consumer',label:'Consumer'},{id:'industrial',label:'Industrial'},{id:'real_estate',label:'Real Estate'},
    {id:'media',label:'Media'},{id:'education',label:'Education'},{id:'venture_capital',label:'Venture Capital'},
    {id:'government',label:'Government'},{id:'other',label:'Other'}
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
      console.log('[CRM] Search:', { keywords: keywordsInput ? keywordsInput.value.trim() : '', industries: industries });
    });
  }

})();