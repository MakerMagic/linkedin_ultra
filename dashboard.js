/**
 * dashboard.js вЂ” LinkedIn CRM v2.5
 *
 * Changes vs v2.4:
 *   - Navigation: "Sync" nav item renamed to "Leads"
 *   - Leads panel: contains Sync sub-tab (existing) + Data sub-tab (new)
 *   - Data sub-tab: contacts table with 30-row pages + pagination
 *   - Search, Help, Contacts (soon) tabs: UNCHANGED
 */
(function () {
  'use strict';

  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
  // рџ‘‰ DEMO VIDEO вЂ” Help tab (with controls)
  const DEMO_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';

  // рџ‘‰ HELP VIDEO вЂ” split screen popover (autoplay loop muted)
  const HELP_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15000;
  const PAGE_SIZE          = 15;

  // в”Ђв”Ђ DOM refs в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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

  // в”Ђв”Ђ Data table refs в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  var ctableBody    = document.getElementById('ctableBody');
  var tableFooter   = document.getElementById('tableFooter');
  var paginationEl  = document.getElementById('tablePagination');
  var paginationInfo = document.getElementById('paginationInfo');
  var dataCardCount = document.getElementById('dataCardCount');
  var dataTabBadge  = document.getElementById('dataTabBadge');

  // в”Ђв”Ђ Table state в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  var tableContacts    = [];
  var tableCurrentPage = 1;
  var currentLeadsTab  = 'sync';

  // в”Ђв”Ђ Demo video (Help tab) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  var demoVideo    = document.getElementById('demoVideo');
  var demoVideoSrc = document.getElementById('demoVideoSrc');
  if (demoVideo && demoVideoSrc && DEMO_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    demoVideoSrc.src = DEMO_VIDEO_URL;
    demoVideo.load();
  }

  // в”Ђв”Ђ Split screen popover video в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
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

  // в”Ђв”Ђ FAQ accordion в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  document.querySelectorAll('.faq__question').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      var answerId = btn.getAttribute('aria-controls');
      var answer   = document.getElementById(answerId);

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

  // в”Ђв”Ђ Main navigation в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function setActiveView(viewId) {
    navButtons.forEach(function (btn) {
      var id = btn.getAttribute('data-nav');
      var active = id === viewId;
      btn.classList.toggle('nav__item--active', active);
      active ? btn.setAttribute('aria-current', 'page') : btn.removeAttribute('aria-current');
    });
    panels.forEach(function (p) {
      p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === viewId);
    });
    var titles = {
      leads:      'LinkedIn CRM — Leads',
      search:     'LinkedIn CRM — Search',
      help:       'LinkedIn CRM — Help',
      networking: 'LinkedIn CRM — Networking'
    };
    document.title = titles[viewId] || 'LinkedIn CRM';
  }

  navButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-nav');
      if (id) setActiveView(id);
    });
  });

  // "Go to sync" links inside other panels
  document.querySelectorAll('[data-go-sync]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      setActiveView('leads');
      setLeadsTab('sync');
    });
  });

  // в”Ђв”Ђ Leads sub-tab switching в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function setLeadsTab(tabId) {
    currentLeadsTab = tabId;

    // Toggle tab buttons
    document.querySelectorAll('.leads-tab').forEach(function (btn) {
      var active = btn.getAttribute('data-leads-tab') === tabId;
      btn.classList.toggle('leads-tab--active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    // Toggle sub-panels
    document.querySelectorAll('.leads-subpanel').forEach(function (panel) {
      var active = panel.getAttribute('data-leads-panel') === tabId;
      panel.classList.toggle('leads-subpanel--active', active);
      panel.hidden = !active;
    });

    // Load contacts when switching to Data tab
    if (tabId === 'data') {
      chrome.storage.local.get(['crm_contacts'], function (data) {
        tableContacts    = data.crm_contacts || [];
        tableCurrentPage = 1;
        clearAllFilters();
        renderDataTableWithSelection();
      });
    }
  }

  // Wire up sub-tab buttons
  document.querySelectorAll('.leads-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-leads-tab');
      if (id) setLeadsTab(id);
    });
  });

  // в”Ђв”Ђ Progress ring в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function setRingProgress(pct) {
    var p = Math.max(0, Math.min(100, pct));
    if (arc) {
      arc.style.strokeDasharray  = String(CIRCUMFERENCE);
      arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100));
    }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // в”Ђв”Ђ ETA formatting в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function formatEta(s) {
    if (s === null || s === undefined || s < 0) return null;
    if (s < 60)  return '~' + Math.max(1, Math.round(s)) + 's';
    var m = Math.round(s / 60);
    if (m < 60)  return '~' + m + ' min';
    var h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? '~' + h + 'h ' + rm + 'min' : '~' + h + 'h';
  }

  // в”Ђв”Ђ State в†’ UI в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function applyState(status, phase, count, percent, total, label, etaSeconds) {
    var running     = status === 'running';
    var isDone      = status === 'done';
    var hasContacts = count > 0;

    if (btnStart) {
      btnStart.disabled    = running;
      btnStart.textContent = isDone
        ? 'Start Over'
        : (status === 'stopped' && hasContacts ? 'Resume Sync' : 'Start Sync');
    }
    if (btnStop) btnStop.disabled = !running;
    if (btnCSV)  btnCSV.disabled  = !hasContacts;

    if (countEl) {
      countEl.textContent = label || (total ? 'Collected ' + count + ' of ' + total : String(count));
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
        running: 'SyncingвЂ¦',
        stopped: 'Stopped',
        done:    'Completed вњ“',
        error:   'Error вЂ” check LinkedIn console'
      })[status] || 'Waiting to start';
    }

    setRingProgress(status === 'idle' ? 0 : percent);

    // Update badge on the Data tab button
    updateDataBadge(count);

    // If Data tab is active and contacts count changed, refresh table
    if (currentLeadsTab === 'data' && (isDone || status === 'stopped')) {
      chrome.storage.local.get(['crm_contacts'], function (data) {
        tableContacts = data.crm_contacts || [];
        if (tableCurrentPage > Math.ceil(tableContacts.length / PAGE_SIZE)) {
          tableCurrentPage = 1;
        }
        renderDataTableWithSelection();
      });
    }
  }

  // в”Ђв”Ђ Data tab badge в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function updateDataBadge(count) {
    if (!dataTabBadge) return;
    if (count > 0) {
      dataTabBadge.textContent = count > 999 ? '999+' : String(count);
      dataTabBadge.hidden      = false;
    } else {
      dataTabBadge.hidden = true;
    }
  }

  // в”Ђв”Ђ Init storage load в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  var ALL_KEYS = [
    'crm_sync_status', 'crm_sync_phase', 'crm_sync_count',
    'crm_sync_percent', 'crm_sync_total', 'crm_sync_label',
    'crm_sync_eta_seconds', 'crm_heartbeat'
  ];

  function loadAndApplyState() {
    chrome.storage.local.get(ALL_KEYS, function (data) {
      var status = data.crm_sync_status || 'idle';
      if (status === 'running' && Date.now() - (data.crm_heartbeat || 0) > HEARTBEAT_STALE_MS) {
        status = 'idle';
        chrome.storage.local.set({ crm_sync_status: 'idle', crm_sync_command: null });
      }
      applyState(
        status,
        data.crm_sync_phase    || '',
        data.crm_sync_count    || 0,
        data.crm_sync_percent  || 0,
        data.crm_sync_total    || null,
        data.crm_sync_label    || '',
        data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null
      );
    });
  }
  loadAndApplyState();

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    var rel = [
      'crm_sync_status', 'crm_sync_phase', 'crm_sync_count',
      'crm_sync_percent', 'crm_sync_total', 'crm_sync_label', 'crm_sync_eta_seconds'
    ];
    if (!rel.some(function (k) { return k in changes; })) return;
    chrome.storage.local.get(ALL_KEYS, function (data) {
      applyState(
        data.crm_sync_status    || 'idle',
        data.crm_sync_phase     || '',
        data.crm_sync_count     || 0,
        data.crm_sync_percent   || 0,
        data.crm_sync_total     || null,
        data.crm_sync_label     || '',
        data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null
      );
    });
  });

  // в”Ђв”Ђ Modal в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function showModal() { if (restartModal) restartModal.hidden = false; }
  function hideModal() { if (restartModal) restartModal.hidden = true; }

  if (restartModal) {
    restartModal.addEventListener('click', function (e) {
      if (e.target === restartModal) hideModal();
    });
  }
  if (btnModalCancel)  btnModalCancel.addEventListener('click', hideModal);
  if (btnModalConfirm) btnModalConfirm.addEventListener('click', async function () {
    hideModal();
    await performRestart();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && restartModal && !restartModal.hidden) hideModal();
  });

  // в”Ђв”Ђ Restart в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  async function performRestart() {
    if (statusEl) statusEl.textContent = 'ResettingвЂ¦';
    if (btnStart) btnStart.disabled = true;
    await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'RESTART_SYNC' }, function (r) {
        if (chrome.runtime.lastError) console.warn('[CRM] RESTART_SYNC:', chrome.runtime.lastError.message);
        resolve();
      });
    });
    if (statusEl) statusEl.textContent = 'Reloading LinkedInвЂ¦';
    await new Promise(function (r) { setTimeout(r, 4000); });
    await handleStart();
  }

  // в”Ђв”Ђ Start в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Connecting to LinkedInвЂ¦';
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
  if (btnStop) {
    btnStop.addEventListener('click', function () {
      chrome.storage.local.set({ crm_sync_command: 'stop' });
    });
  }

  // в”Ђв”Ђ CSV / TSV export в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function downloadTSV(contacts) {
    if (!contacts || !contacts.length) return;
    function clean(v) { return String(v || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' '); }
    var lines = [['Name', 'URL', 'Job Title', 'Company', 'School', 'Major'].join('\t')].concat(
      contacts.map(function (c) {
        return [
          clean(c.fullName), clean(c.profileUrl), clean(c.jobTitle),
          clean(c.company),  clean(c.school),     clean(c.major)
        ].join('\t');
      })
    );
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/tab-separated-values;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = 'linkedin_contacts_' + new Date().toISOString().slice(0, 10) + '.tsv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

  // в”Ђв”Ђ HTML escape в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // в”Ђв”Ђ Data table renderer в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function renderDataTableWithSelection() {
    if (!ctableBody) return;

    var filteredIdx = getFilteredIndices();
    var total      = filteredIdx.length;
    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Clamp page
    if (tableCurrentPage > totalPages) tableCurrentPage = totalPages;
    if (tableCurrentPage < 1)          tableCurrentPage = 1;

    var start = (tableCurrentPage - 1) * PAGE_SIZE;
    var end   = Math.min(start + PAGE_SIZE, total);
    var pageIdx = filteredIdx.slice(start, end);
    var slice = pageIdx.map(function (absIndex) { return tableContacts[absIndex]; });

    // Update header count
    if (dataCardCount) {
      var overall = tableContacts.length;
      dataCardCount.textContent = overall > 0
        ? overall.toLocaleString() + ' contact' + (overall === 1 ? '' : 's')
        : '';
    }

    // в”Ђв”Ђ Empty state в”Ђв”Ђ
    if (slice.length === 0) {
      ctableBody.innerHTML =
        '<tr><td colspan="9">' +
          '<div class="table-empty">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
              '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
              '<circle cx="9" cy="7" r="4"/>' +
              '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
              '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>' +
            '</svg>' +
            '<div>' +
              '<p class="table-empty__title">No contacts yet</p>' +
              '<p class="table-empty__sub">Go to the Sync tab and start a sync to collect contacts.</p>' +
            '</div>' +
          '</div>' +
        '</td></tr>';
      if (tableFooter)    tableFooter.hidden    = true;
      return;
    }

    // в”Ђв”Ђ Rows в”Ђв”Ђ
    var rows = slice.map(function (c, i) {
      var rowNum   = start + i + 1;
      var name     = esc(c.fullName  || '');
      var url      = c.profileUrl   || '';
      var jobTitle = esc(c.jobTitle  || '');
      var company  = esc(c.company   || '');
      var school   = esc(c.school    || '');

      var nameCell;
      if (url) {
        nameCell =
          '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="ctable__link" title="' + name + '">' +
            '<span>' + (name || 'вЂ”') + '</span>' +
            '<svg class="ctable__ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
              '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>' +
            '</svg>' +
          '</a>';
      } else {
        nameCell = '<span>' + (name || '<span class="ctable__dash">вЂ”</span>') + '</span>';
      }

      return '<tr>' +
        '<td class="ctable__num">' + rowNum + '</td>' +
        '<td>' + nameCell + '</td>' +
        '<td>' + (jobTitle || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (company  || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (school   || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
      '</tr>';
    });

    ctableBody.innerHTML = rows.join('');

    // в”Ђв”Ђ Footer в”Ђв”Ђ
    if (tableFooter) tableFooter.hidden = false;

    if (paginationInfo) {
      paginationInfo.textContent = start + 1 + 'вЂ“' + end + ' of ' + total.toLocaleString();
    }

    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
      } else {
        renderPagination(totalPages);
      }
    }
  }

  // в”Ђв”Ђ Pagination renderer в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function getPageRange(cur, total) {
    if (total <= 7) {
      var arr = [];
      for (var i = 1; i <= total; i++) arr.push(i);
      return arr;
    }
    var delta = 2;
    var left  = Math.max(2, cur - delta);
    var right = Math.min(total - 1, cur + delta);
    var range = [1];
    if (left > 2)        range.push('вЂ¦');
    for (var p = left; p <= right; p++) range.push(p);
    if (right < total - 1) range.push('вЂ¦');
    range.push(total);
    return range;
  }

  function renderPagination(totalPages) {
    if (!paginationEl) return;
    var cur = tableCurrentPage;
    var html = '';

    // Prev
    html +=
      '<button class="page-btn page-btn--arrow" id="pagePrev" aria-label="Previous page"' +
        (cur <= 1 ? ' disabled' : '') + '>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
          '<polyline points="15 18 9 12 15 6"/>' +
        '</svg>' +
      '</button>';

    // Pages
    getPageRange(cur, totalPages).forEach(function (p) {
      if (p === 'вЂ¦') {
        html += '<span class="page-ellipsis" aria-hidden="true">вЂ¦</span>';
      } else {
        html +=
          '<button class="page-btn' + (p === cur ? ' page-btn--active' : '') +
          '" data-page="' + p + '" aria-label="Page ' + p + '"' +
          (p === cur ? ' aria-current="page"' : '') + '>' + p + '</button>';
      }
    });

    // Next
    html +=
      '<button class="page-btn page-btn--arrow" id="pageNext" aria-label="Next page"' +
        (cur >= totalPages ? ' disabled' : '') + '>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
          '<polyline points="9 18 15 12 9 6"/>' +
        '</svg>' +
      '</button>';

    paginationEl.innerHTML = html;

    // Bind page number buttons
    paginationEl.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tableCurrentPage = parseInt(btn.getAttribute('data-page'), 10);
        renderDataTableWithSelection();
        // Scroll table into view gently
        var card = document.querySelector('#leads-panel-data .data-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    var prevBtn = paginationEl.querySelector('#pagePrev');
    var nextBtn = paginationEl.querySelector('#pageNext');
    if (prevBtn) prevBtn.addEventListener('click', function () {
      tableCurrentPage--;
      renderDataTableWithSelection();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      tableCurrentPage++;
      renderDataTableWithSelection();
    });
  }

  // в”Ђв”Ђ Search: industries в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  var INDUSTRY_OPTIONS = [
    { id: 'finance',        label: 'Finance'        },
    { id: 'consulting',     label: 'Consulting'     },
    { id: 'tech',           label: 'Technology'     },
    { id: 'ai_ml',          label: 'AI / ML'        },
    { id: 'healthcare',     label: 'Healthcare'     },
    { id: 'energy',         label: 'Energy'         },
    { id: 'consumer',       label: 'Consumer'       },
    { id: 'industrial',     label: 'Industrial'     },
    { id: 'real_estate',    label: 'Real Estate'    },
    { id: 'media',          label: 'Media'          },
    { id: 'education',      label: 'Education'      },
    { id: 'venture_capital',label: 'Venture Capital'},
    { id: 'government',     label: 'Government'     },
    { id: 'other',          label: 'Other'          }
  ];

  var industryRoot  = document.getElementById('industryTags');
  var keywordsInput = document.getElementById('searchKeywords');
  if (industryRoot) {
    INDUSTRY_OPTIONS.forEach(function (opt) {
      var wrap  = document.createElement('label');
      wrap.className = 'tag-select__item';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'tag-select__input';
      input.value = opt.id;
      input.setAttribute('data-industry', opt.id);
      var pill  = document.createElement('span');
      pill.className = 'tag-select__pill';
      pill.textContent = opt.label;
      wrap.appendChild(input);
      wrap.appendChild(pill);
      industryRoot.appendChild(wrap);
    });
  }

  var btnSearch = document.getElementById('btnSearch');
  if (btnSearch) {
    btnSearch.addEventListener('click', function () {
      var industries = industryRoot
        ? Array.from(industryRoot.querySelectorAll('input:checked')).map(function (el) { return el.value; })
        : [];
      console.log('[CRM] Search:', {
        keywords: keywordsInput ? keywordsInput.value.trim() : '',
        industries: industries
      });
    });
  }

  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
  // ENRICH LEADS MODULE (Data Tab)
  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

  var enrichBar          = document.getElementById('enrichBar');
  var enrichSelectAll    = document.getElementById('enrichSelectAll');
  var enrichRangeFrom    = document.getElementById('enrichRangeFrom');
  var enrichRangeTo      = document.getElementById('enrichRangeTo');
  var btnEnrichRange     = document.getElementById('btnEnrichRange');
  var btnEnrichSelected  = document.getElementById('btnEnrichSelected');
  var btnEnrichStop      = document.getElementById('btnEnrichStop');
  var enrichFilterBtn    = document.getElementById('enrichFilterBtn');
  var enrichFilterMenu   = document.getElementById('enrichFilterMenu');
  var enrichFilterLabel  = document.getElementById('enrichFilterLabel');
  var enrichProgress     = document.getElementById('enrichProgress');
  var enrichStatus       = document.getElementById('enrichStatus');
  var enrichCount        = document.getElementById('enrichCount');
  var enrichFill         = document.getElementById('enrichFill');
  var enrichStats        = document.getElementById('enrichStats');
  var btnClearAllData    = document.getElementById('btnClearAllData');
  var enrichSearchInput  = document.getElementById('enrichSearchInput');

  var contactCardModal   = document.getElementById('contactCardModal');
  var contactCardOverlay = document.getElementById('contactCardOverlay');
  var contactCardClose   = document.getElementById('contactCardClose');
  var contactCardAvatar  = document.getElementById('contactCardAvatar');
  var contactCardName    = document.getElementById('contactCardName');
  var contactCardConnection = document.getElementById('contactCardConnection');
  var contactCardUrl     = document.getElementById('contactCardUrl');
  var contactCardJobTitle = document.getElementById('contactCardJobTitle');
  var contactCardCompany = document.getElementById('contactCardCompany');
  var contactCardSchool  = document.getElementById('contactCardSchool');
  var contactCardMajor   = document.getElementById('contactCardMajor');
  var contactCardRegion  = document.getElementById('contactCardRegion');
  var contactCardDescriptionSection = document.getElementById('contactCardDescriptionSection');
  var contactCardDescription = document.getElementById('contactCardDescription');
  var contactCardNotes   = document.getElementById('contactCardNotes');
  var contactCardSaveNotes = document.getElementById('contactCardSaveNotes');
  var contactCardSavedIndicator = document.getElementById('contactCardSavedIndicator');

  // ── Networking Contact Modal (отдельный от Leads) ─────────────────────
  var netContactModal   = document.getElementById('netContactModal');
  var netContactOverlay = document.getElementById('netContactOverlay');
  var netContactClose   = document.getElementById('netContactClose');
  var netContactAvatar  = document.getElementById('netContactAvatar');
  var netContactName    = document.getElementById('netContactName');
  var netContactUrl     = document.getElementById('netContactUrl');
  var netContactBio     = document.getElementById('netContactBio');

  var clearAllConfirmModal = document.getElementById('clearAllConfirmModal');
  var clearAllConfirmOverlay = document.getElementById('clearAllConfirmOverlay');
  var clearAllCancel     = document.getElementById('clearAllCancel');
  var clearAllConfirm    = document.getElementById('clearAllConfirm');

  var currentContactCardIndex = null;
  var selectedRows       = new Set();
  var isEnrichRunning    = false;
  var enrichFilterSet    = new Set();
  var searchKeyword      = '';
  var saveNotesResetTimer = null;
  var saveNotesHideTimer  = null;

  function isContactEnriched(c) {
    if (!c) return false;
    return !!(
      (c.jobTitle && String(c.jobTitle).trim()) ||
      (c.company  && String(c.company).trim())  ||
      (c.school   && String(c.school).trim())   ||
      (c.major    && String(c.major).trim())
    );
  }

  function isContactConnected(c) {
    if (!c) return false;
    return c.connected === true || c.connected === 'YES' || c.connected === 'yes';
  }

  function getFilterLabel() {
    if (enrichFilterSet.size === 0) return 'All';
    if (enrichFilterSet.size === 1) {
      var m = Array.from(enrichFilterSet)[0];
      if (m === 'enriched') return 'Enriched';
      if (m === 'not_enriched') return 'Not enriched';
      if (m === 'connected') return 'Connected';
      if (m === 'not_connected') return 'Not connected';
    }
    return enrichFilterSet.size + ' filters';
  }

  function updateFilterButtons() {
    if (!enrichFilterMenu) return;
    enrichFilterMenu.querySelectorAll('.enrich-filter-dd__item').forEach(function (btn) {
      var filter = btn.getAttribute('data-filter');
      btn.classList.toggle('enrich-filter-dd__item--active', enrichFilterSet.has(filter));
    });
  }

  function contactMatchesSearch(c, keyword) {
    if (!keyword) return true;
    var k = keyword.toLowerCase();
    return (
      (c.firstName && String(c.firstName).toLowerCase().includes(k)) ||
      (c.lastName  && String(c.lastName).toLowerCase().includes(k)) ||
      (c.jobTitle  && String(c.jobTitle).toLowerCase().includes(k)) ||
      (c.company   && String(c.company).toLowerCase().includes(k)) ||
      (c.school    && String(c.school).toLowerCase().includes(k)) ||
      (c.major     && String(c.major).toLowerCase().includes(k))
    );
  }

  function getFilteredIndices() {
    var out = [];
    for (var i = 0; i < tableContacts.length; i++) {
      var c = tableContacts[i];
      var enriched = isContactEnriched(c);
      var connected = isContactConnected(c);

      var hasEnrichedFilter = enrichFilterSet.has('enriched') || enrichFilterSet.has('not_enriched');
      var hasConnectedFilter = enrichFilterSet.has('connected') || enrichFilterSet.has('not_connected');

      if (enrichFilterSet.has('enriched') && !enriched) continue;
      if (enrichFilterSet.has('not_enriched') && enriched) continue;
      if (enrichFilterSet.has('connected') && !connected) continue;
      if (enrichFilterSet.has('not_connected') && connected) continue;

      if (!contactMatchesSearch(c, searchKeyword)) continue;
      out.push(i);
    }
    return out;
  }

  function applyFilters() {
    if (enrichFilterLabel) enrichFilterLabel.textContent = getFilterLabel();
    selectedRows.clear();
    tableCurrentPage = 1;
    renderDataTableWithSelection();
  }

  function clearAllFilters() {
    enrichFilterSet.clear();
    updateFilterButtons();
    applyFilters();
  }

  function setFilterMenuOpen(open) {
    if (!enrichFilterMenu || !enrichFilterBtn) return;
    enrichFilterMenu.hidden = !open;
    enrichFilterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function updateSelectAllState() {
    if (!enrichSelectAll) return;
    var filteredIdx = getFilteredIndices();
    var start = (tableCurrentPage - 1) * PAGE_SIZE;
    var end   = Math.min(start + PAGE_SIZE, filteredIdx.length);
    var allSelected = true;
    var anySelected = false;

    for (var p = start; p < end; p++) {
      var absIndex = filteredIdx[p];
      if (selectedRows.has(absIndex)) anySelected = true;
      else allSelected = false;
    }

    if (end <= start) {
      enrichSelectAll.checked = false;
      enrichSelectAll.indeterminate = false;
    } else if (allSelected) {
      enrichSelectAll.checked = true;
      enrichSelectAll.indeterminate = false;
    } else if (anySelected) {
      enrichSelectAll.checked = false;
      enrichSelectAll.indeterminate = true;
    } else {
      enrichSelectAll.checked = false;
      enrichSelectAll.indeterminate = false;
    }
  }

  function updateEnrichStats() {
    if (!enrichStats) return;
    var count = selectedRows.size;
    var filteredCount = getFilteredIndices().length;
    enrichStats.textContent = (count > 0 ? ('Selected: ' + count + ' В· ') : '') + 'Showing: ' + filteredCount;
  }

  function updateEnrichButton() {
    if (!btnEnrichSelected) return;
    btnEnrichSelected.disabled = selectedRows.size === 0 || isEnrichRunning;
  }

  function renderPaginationWithEnrich(totalPages) {
    if (!paginationEl) return;
    var cur = tableCurrentPage;
    var html = '';

    // Prev
    html +=
      '<button class="page-btn page-btn--arrow" id="pagePrev" aria-label="Previous page"' +
        (cur <= 1 ? ' disabled' : '') + '>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
          '<polyline points="15 18 9 12 15 6"/>' +
        '</svg>' +
      '</button>';


    getPageRange(cur, totalPages).forEach(function (p) {
      if (p === 'вЂ¦') {
        html += '<span class="page-ellipsis" aria-hidden="true">вЂ¦</span>';
      } else {
        html +=
          '<button class="page-btn' + (p === cur ? ' page-btn--active' : '') +
          '" data-page="' + p + '" aria-label="Page ' + p + '"' +
          (p === cur ? ' aria-current="page"' : '') + '>' + p + '</button>';
      }
    });

    // Next
    html +=
      '<button class="page-btn page-btn--arrow" id="pageNext" aria-label="Next page"' +
        (cur >= totalPages ? ' disabled' : '') + '>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
          '<polyline points="9 18 15 12 9 6"/>' +
        '</svg>' +
      '</button>';


    paginationEl.innerHTML = html;


    paginationEl.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tableCurrentPage = parseInt(btn.getAttribute('data-page'), 10);
        renderDataTableWithSelection();
        // Scroll table into view gently
        var card = document.querySelector('#leads-panel-data .data-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    var prevBtn = paginationEl.querySelector('#pagePrev');
    var nextBtn = paginationEl.querySelector('#pageNext');
    if (prevBtn) prevBtn.addEventListener('click', function () {
      tableCurrentPage--;
      renderDataTableWithSelection();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      tableCurrentPage++;
      renderDataTableWithSelection();
    });
  }

  function renderDataTableWithSelection() {
    if (!ctableBody) return;


    var filteredIdx = getFilteredIndices();
    var total      = filteredIdx.length;
    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));


    if (tableCurrentPage > totalPages) tableCurrentPage = totalPages;
    if (tableCurrentPage < 1)          tableCurrentPage = 1;


    var start = (tableCurrentPage - 1) * PAGE_SIZE;
    var end   = Math.min(start + PAGE_SIZE, total);
    var pageIdx = filteredIdx.slice(start, end);
    var slice = pageIdx.map(function (absIndex) { return tableContacts[absIndex]; });


    if (dataCardCount) {
      var overall = tableContacts.length;
      dataCardCount.textContent = overall > 0
        ? overall.toLocaleString() + ' contact' + (overall === 1 ? '' : 's')
        : '';
    }


    if (slice.length === 0) {
      ctableBody.innerHTML =
        '<tr><td colspan="9">' +
          '<div class="table-empty">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
              '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
              '<circle cx="9" cy="7" r="4"/>' +
              '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
              '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>' +
            '</svg>' +
            '<div>' +
              '<p class="table-empty__title">No contacts yet</p>' +
              '<p class="table-empty__sub">Go to the Sync tab and start a sync to collect contacts.</p>' +
            '</div>' +
          '</div>' +
        '</td></tr>';
      if (tableFooter) tableFooter.hidden = true;
      updateEnrichStats();
      updateEnrichButton();
      updateSelectAllState();
      return;
    }


    var rows = slice.map(function (c, i) {
      var absIndex   = pageIdx[i];
      var rowNum     = start + i + 1;
      var isSelected = selectedRows.has(absIndex);
      var firstName  = esc(c.firstName || '');
      var lastName   = esc(c.lastName  || '');
      var url        = c.profileUrl   || '';
      var jobTitle   = esc(c.jobTitle  || '');
      var company    = esc(c.company   || '');
      var school     = esc(c.school    || '');
      var major      = esc(c.major     || '');


      var urlCell;
      if (url) {
        var displayUrl = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (displayUrl.length > 35) displayUrl = displayUrl.slice(0, 32) + 'вЂ¦';
        urlCell =
          '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="ctable__link" title="' + esc(url) + '">' +
            '<span>' + displayUrl + '</span>' +
            '<svg class="ctable__ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
              '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>' +
            '</svg>' +
          '</a>';
      } else {
        urlCell = '<span class="ctable__dash">вЂ”</span>';
      }


      var checkboxCell =
        '<td class="ctable__check">' +
          '<input type="checkbox" data-index="' + absIndex + '" ' + (isSelected ? 'checked' : '') + '>' +
        '</td>';


      var trClass = isSelected ? 'ctable__row--selected' : '';

      var firstNameCell = firstName
        ? '<span class="ctable__name" data-index="' + absIndex + '">' + firstName + '</span>'
        : '<span class="ctable__dash">вЂ”</span>';
      var lastNameCell = lastName
        ? '<span class="ctable__name" data-index="' + absIndex + '">' + lastName + '</span>'
        : '<span class="ctable__dash">вЂ”</span>';

      return '<tr class="' + trClass + '">' +
        checkboxCell +
        '<td class="ctable__num">' + rowNum + '</td>' +
        '<td>' + firstNameCell + '</td>' +
        '<td>' + lastNameCell + '</td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + (jobTitle  || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (company   || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (school    || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (major     || '<span class="ctable__dash">вЂ”</span>') + '</td>' +
      '</tr>';
    });


    ctableBody.innerHTML = rows.join('');


    ctableBody.querySelectorAll('input[type="checkbox"][data-index]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var idx = parseInt(cb.getAttribute('data-index'), 10);
        if (cb.checked) selectedRows.add(idx);
        else selectedRows.delete(idx);
        updateSelectAllState();
        updateEnrichStats();
        updateEnrichButton();
        var tr = cb.closest('tr');
        if (tr) tr.classList.toggle('ctable__row--selected', cb.checked);
      });
    });

    ctableBody.querySelectorAll('.ctable__name').forEach(function (nameEl) {
      nameEl.addEventListener('click', function () {
        var idx = parseInt(nameEl.getAttribute('data-index'), 10);
        openContactCard(idx);
      });
    });


    if (tableFooter) tableFooter.hidden = false;

    if (paginationInfo) {
      if (total === 0) paginationInfo.textContent = '0 of 0';
      else paginationInfo.textContent = (start + 1) + 'вЂ“' + end + ' of ' + total.toLocaleString();
    }


    if (paginationEl) {
      if (totalPages <= 1) paginationEl.innerHTML = '';
      else renderPaginationWithEnrich(totalPages);
    }


    updateSelectAllState();
    updateEnrichStats();
    updateEnrichButton();
  }

  function openContactCard(index) {
    if (!tableContacts[index]) return;
    currentContactCardIndex = index;
    var c = tableContacts[index];

    var notesWrap = contactCardNotes ? contactCardNotes.closest('.contact-card__notes') : null;
    if (notesWrap) notesWrap.hidden = false;
    var grid = contactCardJobTitle ? contactCardJobTitle.closest('.contact-card__grid') : null;
    if (grid) grid.hidden = false;
    var regionWrap = contactCardRegion ? contactCardRegion.closest('.contact-card__section') : null;
    if (regionWrap) regionWrap.hidden = false;
    if (contactCardConnection) contactCardConnection.hidden = false;

    var firstName = c.firstName || '';
    var lastName = c.lastName || '';
    var fullName = (firstName + ' ' + lastName).trim() || 'Unknown';
    var initials = (firstName[0] || '') + (lastName[0] || '');

    if (contactCardAvatar) {
      contactCardAvatar.textContent = initials.toUpperCase();
    }
    if (contactCardName) {
      contactCardName.textContent = fullName;
    }

    if (contactCardConnection) {
      var isConnected = c.connected === true || c.connected === 'YES' || c.connected === 'yes';
      contactCardConnection.textContent = 'Connected: ' + (isConnected ? 'YES' : 'NO');
      contactCardConnection.className = 'contact-card__connection ' + (isConnected ? 'contact-card__connection--yes' : 'contact-card__connection--no');
    }

    if (contactCardUrl) {
      contactCardUrl.href = c.profileUrl || '#';
      contactCardUrl.textContent = c.profileUrl || 'вЂ”';
    }

    if (contactCardDescriptionSection) {
      contactCardDescriptionSection.hidden = true;
    }
    if (contactCardDescription) {
      contactCardDescription.textContent = '';
    }

    if (contactCardJobTitle) {
      contactCardJobTitle.textContent = c.jobTitle || '';
    }
    if (contactCardCompany) {
      contactCardCompany.textContent = c.company || '';
    }
    if (contactCardSchool) {
      contactCardSchool.textContent = c.school || '';
    }
    if (contactCardMajor) {
      contactCardMajor.textContent = c.major || '';
    }
    if (contactCardRegion) {
      contactCardRegion.textContent = c.region || 'вЂ”';
    }
    if (contactCardNotes) {
      contactCardNotes.value = c.notes || '';
    }

    if (contactCardModal) {
      contactCardModal.hidden = false;
    }
  }

  function openNetworkingInviteCard(invite) {
    if (!invite || !netContactModal) return;

    var firstName = invite.firstName || '';
    var lastName  = invite.lastName  || '';
    var fullName  = (String(firstName) + ' ' + String(lastName)).trim() || 'Unknown';
    var initials  = (String(firstName).trim()[0] || '') + (String(lastName).trim()[0] || '');
    var url       = invite.profileUrl ? String(invite.profileUrl) : '';
    var bio       = invite.description || invite.bio || '';

    if (netContactAvatar) netContactAvatar.textContent = initials.toUpperCase();
    if (netContactName)   netContactName.textContent   = fullName;

    if (netContactUrl) {
      netContactUrl.href        = url || '#';
      netContactUrl.textContent = url || '—';
    }

    if (netContactBio) netContactBio.textContent = bio || '—';

    netContactModal.hidden = false;
  }

  function closeNetContactModal() {
    if (netContactModal) netContactModal.hidden = true;
  }

  if (netContactClose)   netContactClose.addEventListener('click', closeNetContactModal);
  if (netContactOverlay) netContactOverlay.addEventListener('click', closeNetContactModal);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && netContactModal && !netContactModal.hidden) {
      closeNetContactModal();
    }
  });

  if (contactCardClose) {
    contactCardClose.addEventListener('click', closeContactCard);
  }
  if (contactCardOverlay) {
    contactCardOverlay.addEventListener('click', closeContactCard);
  }
  if (contactCardSaveNotes) {
    contactCardSaveNotes.addEventListener('click', saveContactNotes);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && contactCardModal && !contactCardModal.hidden) {
      closeContactCard();
    }
  });


  if (enrichSelectAll) {
    enrichSelectAll.addEventListener('change', function () {
      var filteredIdx = getFilteredIndices();
      var start = (tableCurrentPage - 1) * PAGE_SIZE;
      var end   = Math.min(start + PAGE_SIZE, filteredIdx.length);


      if (enrichSelectAll.checked) {
        for (var p = start; p < end; p++) selectedRows.add(filteredIdx[p]);
      } else {
        for (var p = start; p < end; p++) selectedRows.delete(filteredIdx[p]);
      }


      renderDataTableWithSelection();
    });
  }


  if (btnEnrichRange) {
    btnEnrichRange.addEventListener('click', function () {
      var fromVal = parseInt(enrichRangeFrom?.value, 10);
      var toVal   = parseInt(enrichRangeTo?.value, 10);
      if (isNaN(fromVal) || isNaN(toVal)) return;
      var filteredIdx = getFilteredIndices();
      if (filteredIdx.length === 0) return;


      var from = Math.max(1, Math.min(fromVal, filteredIdx.length));
      var to   = Math.max(from, Math.min(toVal, filteredIdx.length));
      for (var i = from - 1; i < to; i++) selectedRows.add(filteredIdx[i]);


      renderDataTableWithSelection();
      if (enrichRangeFrom) enrichRangeFrom.value = '';
      if (enrichRangeTo)   enrichRangeTo.value   = '';
    });
  }


  function updateEnrichProgress(current, total, status) {
    if (enrichCount)  enrichCount.textContent = current + ' / ' + total;
    if (enrichStatus) enrichStatus.textContent = status || ('Processing ' + current + ' of ' + total);
    if (enrichFill)   enrichFill.style.width = total > 0 ? (current / total * 100) + '%' : '0%';
  }


  function stopEnrich() {
    if (!isEnrichRunning) return;
    isEnrichRunning = false;
  }

  async function startEnrich() {
    if (isEnrichRunning) return;
    if (selectedRows.size === 0) return;

    var snap = await new Promise(function (resolve) {
      chrome.storage.local.get(['crm_sync_status'], resolve);
    });
    if (snap.crm_sync_status === 'running') {
      alert('Sync is already running. Please wait for completion or stop it first.');
      return;
    }


    isEnrichRunning = true;
    updateEnrichButton();
    if (enrichProgress) enrichProgress.hidden = false;
    if (btnEnrichStop)  btnEnrichStop.hidden  = false;
    if (enrichBar)      enrichBar.style.opacity = '0.6';


    var indices = Array.from(selectedRows).sort(function (a, b) { return a - b; });
    var toEnrich = indices.map(function (idx) { return tableContacts[idx]; });


    selectedRows.clear();
    renderDataTableWithSelection();


    var processed = 0;
    var total = toEnrich.length;
    updateEnrichProgress(0, total, 'Starting...');


    for (var i = 0; i < toEnrich.length && isEnrichRunning; i++) {
      var contact = toEnrich[i];
      updateEnrichProgress(i, total, 'Opening: ' + (contact.fullName || 'Profile'));


      try {
        var result = await new Promise(function (resolve) {
          chrome.runtime.sendMessage({
            type: 'ENRICH_OPEN_PROFILE',
            profileUrl: contact.profileUrl
          }, function (r) {
            if (chrome.runtime.lastError) {
              resolve({ ok: false });
              return;
            }
            resolve(r || { ok: false });
          });
        });


        if (result.ok && result.data) {
          var NF = 'Not Found';
          contact.jobTitle = (result.data.jobTitle && String(result.data.jobTitle).trim())
            ? result.data.jobTitle
            : (contact.jobTitle && String(contact.jobTitle).trim()) ? contact.jobTitle : NF;
          contact.company  = (result.data.company && String(result.data.company).trim())
            ? result.data.company
            : (contact.company && String(contact.company).trim()) ? contact.company : NF;
          contact.school   = (result.data.school && String(result.data.school).trim())
            ? result.data.school
            : (contact.school && String(contact.school).trim()) ? contact.school : NF;
          contact.major    = (result.data.major && String(result.data.major).trim())
            ? result.data.major
            : (contact.major && String(contact.major).trim()) ? contact.major : NF;
          contact.region   = (result.data.location && String(result.data.location).trim())
            ? result.data.location
            : (contact.region && String(contact.region).trim()) ? contact.region : NF;
        }


        processed++;
        updateEnrichProgress(processed, total, 'Processed: ' + processed + ' of ' + total);
        await saveContactsToStorage();
        renderDataTableWithSelection();
      } catch (err) {
        console.error('[Enrich] Error processing contact:', err);
      }


      if (i < toEnrich.length - 1) {
        await new Promise(function (r) { setTimeout(r, 700 + Math.random() * 300); });
      }
    }


    isEnrichRunning = false;
    if (enrichProgress) enrichProgress.hidden = true;
    if (btnEnrichStop)  btnEnrichStop.hidden  = true;
    if (enrichBar)      enrichBar.style.opacity = '1';
    updateEnrichButton();
    renderDataTableWithSelection();
  }


  if (btnEnrichSelected) btnEnrichSelected.addEventListener('click', startEnrich);
  if (btnEnrichStop)     btnEnrichStop.addEventListener('click', stopEnrich);


  if (enrichFilterBtn && enrichFilterMenu) {
    enrichFilterBtn.addEventListener('click', function () {
      var isHidden = enrichFilterMenu.hidden;
      setFilterMenuOpen(isHidden);
    });


    enrichFilterMenu.querySelectorAll('.enrich-filter-dd__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var value = btn.getAttribute('data-filter');
        if (enrichFilterSet.has(value)) {
          enrichFilterSet.delete(value);
        } else {
          enrichFilterSet.add(value);
        }
        updateFilterButtons();
        applyFilters();
      });
    });


    var enrichFilterClear = document.getElementById('enrichFilterClear');
    if (enrichFilterClear) {
      enrichFilterClear.addEventListener('click', function () {
        clearAllFilters();
      });
    }


    document.addEventListener('click', function (e) {
      if (enrichFilterMenu.hidden) return;
      var t = e.target;
      if (enrichFilterBtn.contains(t)) return;
      if (enrichFilterMenu.contains(t)) return;
      setFilterMenuOpen(false);
    });


    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && enrichFilterMenu && !enrichFilterMenu.hidden) {
        setFilterMenuOpen(false);
      }
    });

    if (enrichSearchInput) {
      enrichSearchInput.addEventListener('input', function () {
        searchKeyword = enrichSearchInput.value.trim();
        tableCurrentPage = 1;
        selectedRows.clear();
        renderDataTableWithSelection();
      });
    }
  }


  applyFilters();


  function closeContactCard() {
    if (contactCardModal) {
      contactCardModal.hidden = true;
    }

    // Restore hidden sections for Leads view
    var notesWrap = contactCardNotes ? contactCardNotes.closest('.contact-card__notes') : null;
    if (notesWrap) notesWrap.hidden = false;
    var grid = contactCardJobTitle ? contactCardJobTitle.closest('.contact-card__grid') : null;
    if (grid) grid.hidden = false;
    var regionWrap = contactCardRegion ? contactCardRegion.closest('.contact-card__section') : null;
    if (regionWrap) regionWrap.hidden = false;
  }

  function saveContactNotes() {
    console.log('[CRM] saveContactNotes called', { currentContactCardIndex, hasContactCardNotes: !!contactCardNotes });
    if (currentContactCardIndex === null || !contactCardNotes) {
      console.log('[CRM] saveContactNotes early exit: no index or notes element');
      return;
    }
    var c = tableContacts[currentContactCardIndex];
    if (!c) {
      console.log('[CRM] saveContactNotes early exit: no contact at index');
      return;
    }

    var oldNotes = String(c.notes || '').trim();
    var newNotes = String(contactCardNotes.value || '').trim();
    console.log('[CRM] saveContactNotes notes:', { oldNotes, newNotes, same: newNotes === oldNotes });
    if (newNotes === oldNotes) {
      console.log('[CRM] saveContactNotes early exit: notes not changed');
      return;
    }

    c.notes = newNotes;
    saveContactsToStorage();
    console.log('[CRM] saveContactNotes saved successfully');

    if (!contactCardSaveNotes) {
      console.log('[CRM] saveContactNotes: no save button element');
      return;
    }

    if (saveNotesResetTimer) clearTimeout(saveNotesResetTimer);
    if (saveNotesHideTimer) clearTimeout(saveNotesHideTimer);

    var originalText = contactCardSaveNotes.textContent;
    contactCardSaveNotes.classList.add('contact-card__save-btn--saved');
    contactCardSaveNotes.textContent = 'Saved';
    console.log('[CRM] saveContactNotes UI updated to Saved state');

    if (contactCardSavedIndicator) {
      contactCardSavedIndicator.classList.add('contact-card__saved-indicator--show');
    }

    saveNotesHideTimer = setTimeout(function () {
      if (contactCardSavedIndicator) {
        contactCardSavedIndicator.classList.remove('contact-card__saved-indicator--show');
      }
    }, 3000);

    saveNotesResetTimer = setTimeout(function () {
      contactCardSaveNotes.classList.remove('contact-card__save-btn--saved');
      contactCardSaveNotes.textContent = originalText;
    }, 3000);
  }

  function showClearAllConfirmModal() {
    if (clearAllConfirmModal) {
      clearAllConfirmModal.hidden = false;
    }
  }

  function hideClearAllConfirmModal() {
    if (clearAllConfirmModal) {
      clearAllConfirmModal.hidden = true;
    }
  }

  function executeClearAllData() {
    chrome.storage.local.set({
      crm_contacts: [],
      crm_sync_count: 0,
      crm_sync_total: null,
      crm_sync_percent: 0,
      crm_sync_label: '0',
      crm_sync_status: 'idle',
      crm_sync_phase: 'idle',
      crm_sync_command: null
    }, function () {
      tableContacts = [];
      selectedRows.clear();
      renderDataTableWithSelection();
      updateDataBadge();
      hideClearAllConfirmModal();
    });
  }

  if (btnClearAllData) {
    btnClearAllData.addEventListener('click', showClearAllConfirmModal);
  }

  if (clearAllCancel) {
    clearAllCancel.addEventListener('click', hideClearAllConfirmModal);
  }

  if (clearAllConfirm) {
    clearAllConfirm.addEventListener('click', executeClearAllData);
  }

  if (clearAllConfirmOverlay) {
    clearAllConfirmOverlay.addEventListener('click', hideClearAllConfirmModal);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && clearAllConfirmModal && !clearAllConfirmModal.hidden) {
      hideClearAllConfirmModal();
    }
  });


  var renderDataTable = renderDataTableWithSelection;

  // в”Ђв”Ђ Save contacts to storage в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  function saveContactsToStorage() {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ crm_contacts: tableContacts }, function () {
        resolve();
      });
    });
  }

  // Table CSV download
  var btnDownloadTableCSV = document.getElementById('btnDownloadTableCSV');
  if (btnDownloadTableCSV) {
    btnDownloadTableCSV.addEventListener('click', function () {
      var filteredIdx = getFilteredIndices();
      if (filteredIdx.length === 0) {
        alert('No contacts to download.');
        return;
      }
      var rows = filteredIdx.map(function (idx) {
        var c = tableContacts[idx];
        return {
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          profileUrl: c.profileUrl || '',
          jobTitle: c.jobTitle || '',
          company: c.company || '',
          school: c.school || '',
          major: c.major || '',
          region: c.region || '',
          connected: c.connected === true || c.connected === 'YES' || c.connected === 'yes' ? 'YES' : 'NO',
          notes: c.notes || ''
        };
      });
      var headers = ['First Name', 'Last Name', 'Profile URL', 'Job Title', 'Company', 'School', 'Major', 'Region', 'Connected', 'Notes'];
      var csv = [headers.join(',')];
      rows.forEach(function (r) {
        var vals = [
          r.firstName,
          r.lastName,
          r.profileUrl,
          r.jobTitle,
          r.company,
          r.school,
          r.major,
          r.region,
          r.connected,
          r.notes
        ].map(function (v) {
          var s = String(v || '');
          if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            s = '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        });
        csv.push(vals.join(','));
      });
      var blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'contacts_' + new Date().toISOString().slice(0, 10) + '.csv';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }


  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
  // NETWORKING MODULE
  // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

  var networkingKeywordsInput = document.getElementById('networkingKeywords');
  var networkingKeywordsList = document.getElementById('networkingKeywordsList');
  var networkingKeywordsSection = document.getElementById('networkingKeywordsSection');
  var btnStartNetworking = document.getElementById('btnStartNetworking');
  var networkingList = document.getElementById('networkingList');
  var networkingListContent = document.getElementById('networkingListContent');
  var networkingEmptyState = document.getElementById('networkingEmptyState');
  var sentInvitesBadge = document.getElementById('sentInvitesBadge');
  var readLogBadge = document.getElementById('readLogBadge');

  var readLogList = document.getElementById('readLogList');
  var readLogListContent = document.getElementById('readLogListContent');
  var readLogEmptyState = document.getElementById('readLogEmptyState');

  var selectedKeywords = [];
  var sentInvites = [];
  var readLog = [];

  var leadsNameSet = new Set();

  function normalizeNamePart(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function nameKey(firstName, lastName) {
    var f = normalizeNamePart(firstName);
    var l = normalizeNamePart(lastName);
    return f + '|' + l;
  }

  function shortUrlLabel(url, maxLen) {
    maxLen = maxLen || 9;
    if (!url) return '';
    try {
      var u = new URL(url);
      var s = (u.host || '') + (u.pathname || '');
      s = s.replace(/^www\./i, '');
      if (s.length <= maxLen) return s;
      return s.slice(0, Math.max(0, maxLen - 1)) + '…';
    } catch {
      var raw = String(url);
      if (raw.length <= maxLen) return raw;
      return raw.slice(0, Math.max(0, maxLen - 1)) + '…';
    }
  }

  function refreshLeadsNameSet(cb) {
    chrome.storage.local.get(['crm_contacts'], function (data) {
      var contacts = data.crm_contacts || [];
      var next = new Set();
      contacts.forEach(function (c) {
        if (!c) return;

        var first = c.firstName;
        var last = c.lastName;

        // Fallback: derive from fullName if needed
        if ((!first || !last) && c.fullName) {
          var parts = String(c.fullName).trim().split(/\s+/);
          first = first || parts[0] || '';
          last = last || (parts.length > 1 ? parts.slice(1).join(' ') : '');
        }

        if (!first && !last) return;
        next.add(nameKey(first, last));
      });
      leadsNameSet = next;
      if (typeof cb === 'function') cb();
    });
  }

  function loadSentInvites() {
    chrome.storage.local.get(['crm_sent_invites'], function (data) {
      sentInvites = data.crm_sent_invites || [];
      updateSentInvitesUI();
    });
  }

  function loadReadLog() {
    chrome.storage.local.get(['crm_networking_read_log'], function (data) {
      readLog = data.crm_networking_read_log || [];
      updateReadLogUI();
    });
  }

  function saveSentInvites() {
    chrome.storage.local.set({ crm_sent_invites: sentInvites });
  }

  function updateSentInvitesBadge() {
    if (!sentInvitesBadge) return;
    var count = sentInvites.length;
    if (count > 0) {
      sentInvitesBadge.textContent = count > 99 ? '99+' : String(count);
      sentInvitesBadge.hidden = false;
    } else {
      sentInvitesBadge.hidden = true;
    }
  }

  function updateReadLogBadge() {
    if (!readLogBadge) return;
    var count = readLog.length;
    if (count > 0) {
      readLogBadge.textContent = count > 99 ? '99+' : String(count);
      readLogBadge.hidden = false;
    } else {
      readLogBadge.hidden = true;
    }
  }

  function createKeywordTag(keyword) {
    var tag = document.createElement('span');
    tag.className = 'networking-tag';
    tag.setAttribute('data-keyword', keyword);
    tag.innerHTML = 
      esc(keyword) +
      '<button type="button" class="networking-tag__remove" aria-label="Remove ' + esc(keyword) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
        '</svg>' +
      '</button>';
    
    tag.querySelector('.networking-tag__remove').addEventListener('click', function () {
      removeKeyword(keyword);
    });
    
    return tag;
  }

  function addKeyword(keyword) {
    keyword = keyword.trim();
    console.log('[Networking] Adding keyword:', keyword);
    if (!keyword) {
      console.log('[Networking] Empty keyword, skipping');
      return;
    }
    if (selectedKeywords.includes(keyword)) {
      console.log('[Networking] Keyword already exists:', keyword);
      return;
    }
    if (selectedKeywords.length >= 10) {
      alert('Maximum 10 keywords allowed');
      return;
    }
    
    selectedKeywords.push(keyword);
    console.log('[Networking] Keywords now:', selectedKeywords);
    renderKeywords();
    saveNetworkingKeywords();
  }

  function removeKeyword(keyword) {
    selectedKeywords = selectedKeywords.filter(function (k) { return k !== keyword; });
    renderKeywords();
    saveNetworkingKeywords();
  }

  function renderKeywords() {
    console.log('[Networking] Rendering keywords:', selectedKeywords);
    if (!networkingKeywordsList) {
      console.error('[Networking] Keywords list element not found');
      return;
    }
    
    networkingKeywordsList.innerHTML = '';
    selectedKeywords.forEach(function (keyword) {
      networkingKeywordsList.appendChild(createKeywordTag(keyword));
    });
    
    if (networkingKeywordsSection) {
      networkingKeywordsSection.hidden = selectedKeywords.length === 0;
      console.log('[Networking] Section visibility:', !networkingKeywordsSection.hidden);
    }
  }

  function saveNetworkingKeywords() {
    chrome.storage.local.set({ crm_networking_keywords: selectedKeywords });
  }

  function loadNetworkingKeywords() {
    chrome.storage.local.get(['crm_networking_keywords'], function (data) {
      selectedKeywords = data.crm_networking_keywords || [];
      renderKeywords();
    });
  }

  if (networkingKeywordsInput) {
    networkingKeywordsInput.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var value = networkingKeywordsInput.value.trim();
        if (value) {
          var keywords = value.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
          keywords.forEach(addKeyword);
          networkingKeywordsInput.value = '';
          networkingKeywordsInput.focus();
        }
      }
    });
  } else {
    console.error('[Networking] Keywords input not found');
  }

  if (btnStartNetworking) {
    btnStartNetworking.addEventListener('click', function () {
      if (selectedKeywords.length === 0) {
        alert('Please add at least one keyword');
        return;
      }
      
      saveNetworkingKeywords();
      
      chrome.tabs.create({
        url: 'https://www.linkedin.com/mynetwork/grow/',
        active: true
      });
    });
  }

  function setNetworkingTab(tabId) {
    document.querySelectorAll('.networking-tab').forEach(function (btn) {
      var active = btn.getAttribute('data-networking-tab') === tabId;
      btn.classList.toggle('networking-tab--active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    
    document.querySelectorAll('.networking-subpanel').forEach(function (panel) {
      var active = panel.getAttribute('data-networking-panel') === tabId;
      panel.classList.toggle('networking-subpanel--active', active);
      panel.hidden = !active;
    });
    
    if (tabId === 'sent') {
      loadSentInvites();
    }

    if (tabId === 'read') {
      loadReadLog();
    }
  }

  document.querySelectorAll('.networking-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-networking-tab');
      if (id) setNetworkingTab(id);
    });
  });

  function updateSentInvitesUI() {
    updateSentInvitesBadge();
    
    if (!networkingList || !networkingListContent || !networkingEmptyState) return;
    
    if (sentInvites.length === 0) {
      networkingList.hidden = true;
      networkingEmptyState.hidden = false;
      return;
    }
    
    networkingEmptyState.hidden = true;
    networkingList.hidden = false;
    
    networkingListContent.innerHTML = sentInvites.map(function (invite, idx) {
      var url = invite && invite.profileUrl ? String(invite.profileUrl) : '';
      var urlLabel = url ? shortUrlLabel(url, 9) : '';
      var desc = invite && (invite.description || invite.bio) ? String(invite.description || invite.bio) : '';

      var status = 'Not Connected';
      if (invite) {
        var key = nameKey(invite.firstName, invite.lastName);
        if (leadsNameSet.has(key)) status = 'Connected';
      }

      var urlCell;
      if (url) {
        urlCell = '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="ctable__link" title="' + esc(url) + '">' +
          '<span>' + esc(urlLabel) + '</span>' +
          '<svg class="ctable__ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
            '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>' +
          '</svg>' +
        '</a>';
      } else {
        urlCell = '<span class="ctable__dash">Not Found</span>';
      }

      var firstNameCell = invite.firstName
        ? '<span class="ctable__name" data-invite-index="' + idx + '">' + esc(invite.firstName) + '</span>'
        : '<span class="ctable__dash">Not Found</span>';
      var lastNameCell = invite.lastName
        ? '<span class="ctable__name" data-invite-index="' + idx + '">' + esc(invite.lastName) + '</span>'
        : '<span class="ctable__dash">Not Found</span>';

      return '<tr>' +
        '<td>' + firstNameCell + '</td>' +
        '<td>' + lastNameCell + '</td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + esc(desc || 'Not Found') + '</td>' +
        '<td>' + esc(status) + '</td>' +
      '</tr>';
    }).join('');

    networkingListContent.querySelectorAll('.ctable__name[data-invite-index]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = parseInt(el.getAttribute('data-invite-index'), 10);
        if (isNaN(i) || !sentInvites[i]) return;
        openNetworkingInviteCard(sentInvites[i]);
      });
    });
  }

  function updateReadLogUI() {
    updateReadLogBadge();
    if (!readLogList || !readLogListContent || !readLogEmptyState) return;

    if (readLog.length === 0) {
      readLogList.hidden = true;
      readLogEmptyState.hidden = false;
      return;
    }

    readLogEmptyState.hidden = true;
    readLogList.hidden = false;

    readLogListContent.innerHTML = readLog.map(function (item) {
      var url = item && item.profileUrl ? String(item.profileUrl) : '';
      var urlCell;
      if (url) {
        var displayUrl = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (displayUrl.length > 35) displayUrl = displayUrl.slice(0, 32) + 'вЂ¦';
        urlCell = '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="ctable__link" title="' + esc(url) + '">' +
          '<span>' + esc(displayUrl) + '</span>' +
          '<svg class="ctable__ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
            '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>' +
          '</svg>' +
        '</a>';
      } else {
        urlCell = '<span class="ctable__dash">вЂ”</span>';
      }

      return '<tr>' +
        '<td>' + (item.firstName ? esc(item.firstName) : '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + (item.lastName ? esc(item.lastName) : '<span class="ctable__dash">вЂ”</span>') + '</td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + esc(item.bio || item.description || '') + '</td>' +
      '</tr>';
    }).join('');
  }

  loadNetworkingKeywords();
  loadSentInvites();
  loadReadLog();
  refreshLeadsNameSet(function () {
    updateSentInvitesUI();
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.crm_sent_invites) {
      sentInvites = changes.crm_sent_invites.newValue || [];
      updateSentInvitesUI();
    }

    if (changes.crm_networking_read_log) {
      readLog = changes.crm_networking_read_log.newValue || [];
      updateReadLogUI();
    }

    if (changes.crm_contacts) {
      refreshLeadsNameSet(function () {
        updateSentInvitesUI();
      });
    }
  });
})();
