/**
 * dashboard.js — LinkedIn CRM v2.5
 *
 * Changes vs v2.4:
 *   - Navigation: "Sync" nav item renamed to "Leads"
 *   - Leads panel: contains Sync sub-tab (existing) + Data sub-tab (new)
 *   - Data sub-tab: contacts table with 30-row pages + pagination
 *   - Search, Help, Contacts (soon) tabs: UNCHANGED
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // 👉 DEMO VIDEO — Help tab (with controls)
  const DEMO_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';

  // 👉 HELP VIDEO — split screen popover (autoplay loop muted)
  const HELP_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  // ═══════════════════════════════════════════════════════════════════════

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15000;
  const PAGE_SIZE          = 30;

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

  // ── Data table refs ───────────────────────────────────────────────────
  var ctableBody    = document.getElementById('ctableBody');
  var tableFooter   = document.getElementById('tableFooter');
  var paginationEl  = document.getElementById('tablePagination');
  var paginationInfo = document.getElementById('paginationInfo');
  var dataCardCount = document.getElementById('dataCardCount');
  var dataTabBadge  = document.getElementById('dataTabBadge');

  // ── Table state ────────────────────────────────────────────────────────
  var tableContacts    = [];
  var tableCurrentPage = 1;
  var currentLeadsTab  = 'sync';

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

  // ── Main navigation ────────────────────────────────────────────────────
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
      leads:  'LinkedIn CRM — Leads',
      search: 'LinkedIn CRM — Search',
      help:   'LinkedIn CRM — Help'
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

  // ── Leads sub-tab switching ────────────────────────────────────────────
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
        renderDataTable();
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

  // ── Progress ring ──────────────────────────────────────────────────────
  function setRingProgress(pct) {
    var p = Math.max(0, Math.min(100, pct));
    if (arc) {
      arc.style.strokeDasharray  = String(CIRCUMFERENCE);
      arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100));
    }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  // ── ETA formatting ─────────────────────────────────────────────────────
  function formatEta(s) {
    if (s === null || s === undefined || s < 0) return null;
    if (s < 60)  return '~' + Math.max(1, Math.round(s)) + 's';
    var m = Math.round(s / 60);
    if (m < 60)  return '~' + m + ' min';
    var h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? '~' + h + 'h ' + rm + 'min' : '~' + h + 'h';
  }

  // ── State → UI ─────────────────────────────────────────────────────────
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
        running: 'Syncing…',
        stopped: 'Stopped',
        done:    'Completed ✓',
        error:   'Error — check LinkedIn console'
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
        renderDataTable();
      });
    }
  }

  // ── Data tab badge ─────────────────────────────────────────────────────
  function updateDataBadge(count) {
    if (!dataTabBadge) return;
    if (count > 0) {
      dataTabBadge.textContent = count > 999 ? '999+' : String(count);
      dataTabBadge.hidden      = false;
    } else {
      dataTabBadge.hidden = true;
    }
  }

  // ── Init storage load ──────────────────────────────────────────────────
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

  // ── Modal ──────────────────────────────────────────────────────────────
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
  if (btnStop) {
    btnStop.addEventListener('click', function () {
      chrome.storage.local.set({ crm_sync_command: 'stop' });
    });
  }

  // ── CSV / TSV export ───────────────────────────────────────────────────
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

  // ── HTML escape ────────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Data table renderer ────────────────────────────────────────────────
  function renderDataTable() {
    if (!ctableBody) return;

    var contacts   = tableContacts;
    var total      = contacts.length;
    var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Clamp page
    if (tableCurrentPage > totalPages) tableCurrentPage = totalPages;
    if (tableCurrentPage < 1)          tableCurrentPage = 1;

    var start = (tableCurrentPage - 1) * PAGE_SIZE;
    var end   = Math.min(start + PAGE_SIZE, total);
    var slice = contacts.slice(start, end);

    // Update header count
    if (dataCardCount) {
      dataCardCount.textContent = total > 0
        ? total.toLocaleString() + ' contact' + (total === 1 ? '' : 's')
        : '';
    }

    // ── Empty state ──
    if (slice.length === 0) {
      ctableBody.innerHTML =
        '<tr><td colspan="5">' +
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

    // ── Rows ──
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
            '<span>' + (name || '—') + '</span>' +
            '<svg class="ctable__ext" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
              '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
              '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>' +
            '</svg>' +
          '</a>';
      } else {
        nameCell = '<span>' + (name || '<span class="ctable__dash">—</span>') + '</span>';
      }

      return '<tr>' +
        '<td class="ctable__num">' + rowNum + '</td>' +
        '<td>' + nameCell + '</td>' +
        '<td>' + (jobTitle || '<span class="ctable__dash">—</span>') + '</td>' +
        '<td>' + (company  || '<span class="ctable__dash">—</span>') + '</td>' +
        '<td>' + (school   || '<span class="ctable__dash">—</span>') + '</td>' +
      '</tr>';
    });

    ctableBody.innerHTML = rows.join('');

    // ── Footer ──
    if (tableFooter) tableFooter.hidden = false;

    if (paginationInfo) {
      paginationInfo.textContent = start + 1 + '–' + end + ' of ' + total.toLocaleString();
    }

    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
      } else {
        renderPagination(totalPages);
      }
    }
  }

  // ── Pagination renderer ────────────────────────────────────────────────
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
    if (left > 2)        range.push('…');
    for (var p = left; p <= right; p++) range.push(p);
    if (right < total - 1) range.push('…');
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
      if (p === '…') {
        html += '<span class="page-ellipsis" aria-hidden="true">…</span>';
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
        renderDataTable();
        // Scroll table into view gently
        var card = document.querySelector('#leads-panel-data .data-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    var prevBtn = paginationEl.querySelector('#pagePrev');
    var nextBtn = paginationEl.querySelector('#pageNext');
    if (prevBtn) prevBtn.addEventListener('click', function () {
      tableCurrentPage--;
      renderDataTable();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      tableCurrentPage++;
      renderDataTable();
    });
  }

  // ── Search: industries ─────────────────────────────────────────────────
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

})();