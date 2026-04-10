/**
 * dashboard.js — LinkedIn CRM v3.0
 *
 * Leads → Sync: collect firstName/lastName/URL (no auto-enrichment)
 * Leads → Data: table + checkbox selection + "Enrich Data" + row-by-row update + Export CSV
 * Help: demo video + FAQ
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════
  // 👉 Set your video URLs here
  const DEMO_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  const HELP_VIDEO_URL = 'PASTE_YOUR_VIDEO_LINK_HERE';
  // ═══════════════════════════════════════════════

  const CIRCUMFERENCE      = 2 * Math.PI * 52;
  const HEARTBEAT_STALE_MS = 15000;

  // ── DOM refs ─────────────────────────────────────────────────────────
  var arc             = document.getElementById('progressArc');
  var pctEl           = document.getElementById('progressPercent');
  var statusEl        = document.getElementById('syncStatus');
  var countEl         = document.getElementById('syncCount');
  var etaEl           = document.getElementById('syncEta');
  var etaTextEl       = document.getElementById('syncEtaText');
  var btnStart        = document.getElementById('btnStart');
  var btnStop         = document.getElementById('btnStop');
  var btnEnrich       = document.getElementById('btnEnrich');
  var btnEnrichStop   = document.getElementById('btnEnrichStop');
  var btnExportCSV    = document.getElementById('btnExportCSV');
  var btnSelectAll    = document.getElementById('btnSelectAll');
  var checkAll        = document.getElementById('checkAll');
  var dataTableBody   = document.getElementById('dataTableBody');
  var tableEmpty      = document.getElementById('tableEmpty');
  var enrichProgress  = document.getElementById('enrichProgress');
  var enrichFill      = document.getElementById('enrichProgressFill');
  var enrichLabel     = document.getElementById('enrichProgressLabel');
  var restartModal    = document.getElementById('restartModal');
  var btnModalConfirm = document.getElementById('btnModalConfirm');
  var btnModalCancel  = document.getElementById('btnModalCancel');

  // ── Videos ───────────────────────────────────────────────────────────
  var demoVideo    = document.getElementById('demoVideo');
  var demoVideoSrc = document.getElementById('demoVideoSrc');
  if (demoVideo && demoVideoSrc && DEMO_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    demoVideoSrc.src = DEMO_VIDEO_URL; demoVideo.load();
  }
  var helpVideoEl  = document.getElementById('w4m9qx');
  var helpVideoSrc = document.getElementById('w4m9qxSrc');
  if (helpVideoEl && helpVideoSrc && HELP_VIDEO_URL !== 'PASTE_YOUR_VIDEO_LINK_HERE') {
    helpVideoSrc.src = HELP_VIDEO_URL; helpVideoEl.load();
  }

  // Split screen popover
  var helpBtn     = document.getElementById('splitscreenHelpBtn');
  var helpPopover = document.getElementById('splitscreenPopover');
  if (helpBtn && helpPopover) {
    helpBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = !helpPopover.hidden;
      helpPopover.hidden = isOpen;
      helpBtn.setAttribute('aria-expanded', String(!isOpen));
      if (helpVideoEl) { if (!isOpen) helpVideoEl.play().catch(function(){}); else helpVideoEl.pause(); }
    });
    document.addEventListener('click', function(e) {
      if (!helpPopover.hidden && !helpPopover.contains(e.target) && e.target !== helpBtn) {
        helpPopover.hidden = true; helpBtn.setAttribute('aria-expanded','false');
        if (helpVideoEl) helpVideoEl.pause();
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !helpPopover.hidden) {
        helpPopover.hidden = true; helpBtn.setAttribute('aria-expanded','false');
        if (helpVideoEl) helpVideoEl.pause();
      }
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────
  var navLeads     = document.getElementById('navLeads');
  var leadsSubtabs = document.getElementById('leadsSubtabs');
  var allPanels    = document.querySelectorAll('.main-panel[data-panel]');

  function setPanel(panelId) {
    allPanels.forEach(function(p) {
      p.classList.toggle('main-panel--active', p.getAttribute('data-panel') === panelId);
    });
    // Nav highlight
    var isLeads = panelId === 'sync' || panelId === 'data';
    if (navLeads) navLeads.classList.toggle('nav__item--active', isLeads);
    document.querySelectorAll('.nav__item[data-nav="help"]').forEach(function(b) {
      b.classList.toggle('nav__item--active', panelId === 'help');
    });
    var titles = { sync:'LinkedIn CRM — Leads', data:'LinkedIn CRM — Data', help:'LinkedIn CRM — Help' };
    document.title = titles[panelId] || 'LinkedIn CRM';
  }

  if (navLeads) {
    navLeads.addEventListener('click', function() {
      var isExpanded = leadsSubtabs.classList.contains('nav__subtabs--open');
      leadsSubtabs.classList.toggle('nav__subtabs--open', !isExpanded);
      navLeads.classList.toggle('nav__item--expanded', !isExpanded);
      if (!isExpanded) { setPanel('sync'); setActiveSubnav('sync'); }
    });
  }

  document.querySelectorAll('.nav__subitem[data-subnav]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = btn.getAttribute('data-subnav');
      setPanel(id);
      setActiveSubnav(id);
      if (id === 'data') loadTable();
      // Keep leads open
      if (leadsSubtabs) leadsSubtabs.classList.add('nav__subtabs--open');
      if (navLeads) { navLeads.classList.add('nav__item--expanded'); navLeads.classList.add('nav__item--active'); }
    });
  });

  function setActiveSubnav(id) {
    document.querySelectorAll('.nav__subitem').forEach(function(b) {
      b.classList.toggle('nav__subitem--active', b.getAttribute('data-subnav') === id);
    });
  }

  document.querySelectorAll('.nav__item[data-nav="help"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setPanel('help');
      if (navLeads) navLeads.classList.remove('nav__item--active');
    });
  });

  // Init state: leads expanded, sync active
  if (leadsSubtabs) leadsSubtabs.classList.add('nav__subtabs--open');
  if (navLeads) navLeads.classList.add('nav__item--expanded');

  // ── Progress ring ─────────────────────────────────────────────────────
  function setRingProgress(pct) {
    var p = Math.max(0, Math.min(100, pct));
    if (arc) { arc.style.strokeDasharray = String(CIRCUMFERENCE); arc.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - p / 100)); }
    if (pctEl) pctEl.textContent = String(Math.round(p));
  }

  function formatEta(s) {
    if (s === null || s === undefined || s < 0) return null;
    if (s < 60) return '~' + Math.max(1, Math.round(s)) + 's';
    var m = Math.round(s / 60);
    if (m < 60) return '~' + m + ' min';
    var h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? '~' + h + 'h ' + rm + 'min' : '~' + h + 'h';
  }

  // ── Sync state → UI ───────────────────────────────────────────────────
  function applyState(status, count, percent, total, label, etaSeconds) {
    var running = status === 'running';
    var isDone  = status === 'done';
    var hasContacts = count > 0;

    if (btnStart) {
      btnStart.disabled = running;
      btnStart.textContent = isDone ? 'Start Over' : (status === 'stopped' && hasContacts ? 'Resume Sync' : 'Start Sync');
    }
    if (btnStop) btnStop.disabled = !running;
    if (countEl) countEl.textContent = label || String(count);

    if (etaEl && etaTextEl) {
      var showEta = running && total && count >= 10 && etaSeconds !== null;
      var str = showEta ? formatEta(etaSeconds) : null;
      if (str) { etaTextEl.textContent = str + ' left'; etaEl.hidden = false; }
      else etaEl.hidden = true;
    }
    if (statusEl) {
      statusEl.textContent = ({
        idle:'Waiting to start', running:'Syncing…', stopped:'Stopped',
        done:'Completed ✓', error:'Error — check console'
      })[status] || 'Waiting to start';
    }
    setRingProgress(status === 'idle' ? 0 : percent);
  }

  var ALL_KEYS = ['crm_sync_status','crm_sync_count','crm_sync_percent','crm_sync_total','crm_sync_label','crm_sync_eta_seconds','crm_heartbeat'];

  function loadSyncState() {
    chrome.storage.local.get(ALL_KEYS, function(data) {
      var status = data.crm_sync_status || 'idle';
      if (status === 'running' && Date.now() - (data.crm_heartbeat||0) > HEARTBEAT_STALE_MS) {
        status = 'idle';
        chrome.storage.local.set({ crm_sync_status:'idle', crm_sync_command:null });
      }
      applyState(status, data.crm_sync_count||0, data.crm_sync_percent||0, data.crm_sync_total||null, data.crm_sync_label||'', data.crm_sync_eta_seconds != null ? data.crm_sync_eta_seconds : null);
    });
  }
  loadSyncState();

  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local') return;
    var syncRel = ['crm_sync_status','crm_sync_count','crm_sync_percent','crm_sync_total','crm_sync_label','crm_sync_eta_seconds'];
    if (syncRel.some(function(k){ return k in changes; })) loadSyncState();
    // Refresh Data panel if open and contacts changed
    if ('crm_contacts' in changes && document.querySelector('.main-panel--active[data-panel="data"]')) loadTable();
  });

  // ── Sync buttons ──────────────────────────────────────────────────────
  if (btnStart) {
    btnStart.addEventListener('click', function() {
      chrome.storage.local.get(['crm_sync_status'], function(data) {
        if ((data.crm_sync_status||'idle') === 'done') showModal();
        else handleStart();
      });
    });
  }
  if (btnStop) btnStop.addEventListener('click', function() { chrome.storage.local.set({ crm_sync_command:'stop' }); });

  async function handleStart() {
    if (btnStart) btnStart.disabled = true;
    if (statusEl) statusEl.textContent = 'Connecting…';
    var ok = await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type:'ENSURE_CONTENT_SCRIPT' }, function(r) {
        if (chrome.runtime.lastError) { resolve(true); return; }
        resolve(r && r.ok !== false);
      });
    });
    if (!ok) {
      if (statusEl) statusEl.textContent = 'Error: open LinkedIn Connections tab';
      if (btnStart) btnStart.disabled = false;
      return;
    }
    chrome.storage.local.set({ crm_sync_command:'start', crm_sync_status:'running' });
  }

  // ── Modal ─────────────────────────────────────────────────────────────
  function showModal() { if (restartModal) restartModal.hidden = false; }
  function hideModal() { if (restartModal) restartModal.hidden = true; }
  if (restartModal) restartModal.addEventListener('click', function(e){ if(e.target===restartModal) hideModal(); });
  if (btnModalCancel) btnModalCancel.addEventListener('click', hideModal);
  if (btnModalConfirm) btnModalConfirm.addEventListener('click', async function() {
    hideModal();
    if (statusEl) statusEl.textContent = 'Resetting…';
    if (btnStart) btnStart.disabled = true;
    await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type:'RESTART_SYNC' }, function(r) {
        if (chrome.runtime.lastError) console.warn('[CRM]', chrome.runtime.lastError.message);
        resolve();
      });
    });
    if (statusEl) statusEl.textContent = 'Reloading…';
    await new Promise(function(r){ setTimeout(r,4000); });
    await handleStart();
  });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && restartModal && !restartModal.hidden) hideModal(); });

  // ── DATA TABLE ─────────────────────────────────────────────────────────

  var tableContacts = [];

  function loadTable() {
    chrome.storage.local.get(['crm_contacts'], function(data) {
      tableContacts = data.crm_contacts || [];
      renderTable(tableContacts);
      updateEnrichButton();
      if (btnExportCSV) btnExportCSV.disabled = tableContacts.length === 0;
    });
  }

  function renderTable(contacts) {
    if (!dataTableBody) return;
    if (contacts.length === 0) {
      dataTableBody.innerHTML = '';
      if (tableEmpty) tableEmpty.hidden = false;
      return;
    }
    if (tableEmpty) tableEmpty.hidden = true;
    var html = '';
    contacts.forEach(function(c, i) {
      var enriched = !!(c.jobTitle || c.company || c.school);
      var cls      = enriched ? 'row--enriched' : '';
      var shortUrl = (c.profileUrl||'').replace('https://www.linkedin.com/in/','');
      html += '<tr data-idx="'+i+'" class="'+cls+'">';
      html += '<td class="col-check"><input type="checkbox" class="row-check" data-idx="'+i+'" aria-label="Select row"></td>';
      html += '<td>'+esc(c.firstName||'')+'</td>';
      html += '<td>'+esc(c.lastName||'')+'</td>';
      html += '<td class="cell--url col-url"><a href="'+esc(c.profileUrl||'')+'" target="_blank" title="'+esc(c.profileUrl||'')+'">'+esc(shortUrl)+'</a></td>';
      html += '<td class="cell--muted">'+esc(c.jobTitle||'')+'</td>';
      html += '<td class="cell--muted">'+esc(c.company||'')+'</td>';
      html += '<td class="cell--muted">'+esc(c.school||'')+'</td>';
      html += '<td class="cell--muted">'+esc(c.major||'')+'</td>';
      html += '</tr>';
    });
    dataTableBody.innerHTML = html;
    dataTableBody.querySelectorAll('.row-check').forEach(function(cb) {
      cb.addEventListener('change', function() { updateEnrichButton(); updateCheckAll(); });
    });
  }

  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function getSelectedIndices() {
    var out = [];
    if (!dataTableBody) return out;
    dataTableBody.querySelectorAll('.row-check:checked').forEach(function(cb) {
      out.push(parseInt(cb.getAttribute('data-idx'),10));
    });
    return out;
  }

  function updateEnrichButton() {
    if (!btnEnrich) return;
    var sel = getSelectedIndices();
    btnEnrich.disabled = sel.length === 0 || enrichRunning;
    btnEnrich.innerHTML = sel.length > 0
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Enrich '+sel.length+' contact'+(sel.length>1?'s':'')
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Enrich Data';
  }

  function updateCheckAll() {
    if (!checkAll || !dataTableBody) return;
    var all  = dataTableBody.querySelectorAll('.row-check');
    var chkd = dataTableBody.querySelectorAll('.row-check:checked');
    checkAll.checked       = all.length > 0 && chkd.length === all.length;
    checkAll.indeterminate = chkd.length > 0 && chkd.length < all.length;
  }

  if (checkAll) {
    checkAll.addEventListener('change', function() {
      if (!dataTableBody) return;
      dataTableBody.querySelectorAll('.row-check').forEach(function(cb){ cb.checked = checkAll.checked; });
      updateEnrichButton();
    });
  }

  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', function() {
      if (!dataTableBody) return;
      var allC  = dataTableBody.querySelectorAll('.row-check');
      var chkdC = dataTableBody.querySelectorAll('.row-check:checked');
      var toCheck = chkdC.length < allC.length;
      allC.forEach(function(cb){ cb.checked = toCheck; });
      if (checkAll) checkAll.checked = toCheck;
      updateEnrichButton();
    });
  }

  // ── ENRICH SELECTED ────────────────────────────────────────────────────

  var enrichRunning      = false;
  var enrichStopRequested = false;

  if (btnEnrich) {
    btnEnrich.addEventListener('click', function() {
      if (enrichRunning) return;
      var indices = getSelectedIndices();
      if (!indices.length) return;
      startEnrich(indices);
    });
  }

  if (btnEnrichStop) {
    btnEnrichStop.addEventListener('click', function() {
      enrichStopRequested = true;
      chrome.runtime.sendMessage({ type:'STOP_PIPELINE' }).catch(function(){});
    });
  }

  async function startEnrich(indices) {
    enrichRunning = true;
    enrichStopRequested = false;
    if (btnEnrich) btnEnrich.disabled = true;
    if (btnEnrichStop) btnEnrichStop.disabled = false;
    if (enrichProgress) enrichProgress.hidden = false;

    var total = indices.length, done = 0;
    updateEnrichProgressUI(done, total);

    // Ensure connections tab exists (needed for profile tabs to open in same window)
    await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type:'ENSURE_CONTENT_SCRIPT' }, function(r) {
        if (chrome.runtime.lastError) console.warn('[CRM] ENSURE_CONTENT_SCRIPT:', chrome.runtime.lastError.message);
        resolve();
      });
    });

    for (var i = 0; i < indices.length; i++) {
      if (enrichStopRequested) { console.log('[CRM] Enrich stopped by user'); break; }

      var idx     = indices[i];
      var contact = tableContacts[idx];
      if (!contact) { done++; updateEnrichProgressUI(done, total); continue; }

      // Skip already-enriched
      if (contact.jobTitle || contact.company || contact.school) {
        done++; updateEnrichProgressUI(done, total);
        markRowEnriching(idx, false); continue;
      }

      markRowEnriching(idx, true);

      var enriched = await new Promise(function(resolve) {
        var c = contact;
        chrome.runtime.sendMessage(
          { type:'ENRICH_CONTACTS', contacts:[c], pauseMs:700 },
          function(r) {
            if (chrome.runtime.lastError || !r || !r.ok) { resolve(c); return; }
            resolve((r.enriched && r.enriched[0]) || c);
          }
        );
      });

      // Update in-memory
      tableContacts[idx] = enriched;

      // Persist to storage
      chrome.storage.local.set({ crm_contacts: tableContacts });

      // Update row without full re-render
      updateTableRow(idx, enriched);
      markRowEnriching(idx, false);

      done++;
      updateEnrichProgressUI(done, total);
    }

    enrichRunning = false;
    if (btnEnrich) { btnEnrich.disabled = false; updateEnrichButton(); }
    if (btnEnrichStop) btnEnrichStop.disabled = true;
    if (enrichProgress) enrichProgress.hidden = true;
  }

  function updateEnrichProgressUI(done, total) {
    if (!enrichFill || !enrichLabel) return;
    var pct = total > 0 ? Math.round(done/total*100) : 0;
    enrichFill.style.width = pct + '%';
    enrichLabel.textContent = 'Enriching ' + done + ' / ' + total + '…';
  }

  function markRowEnriching(idx, active) {
    if (!dataTableBody) return;
    var row = dataTableBody.querySelector('tr[data-idx="'+idx+'"]');
    if (row) row.classList.toggle('row--enriching', active);
  }

  function updateTableRow(idx, contact) {
    if (!dataTableBody) return;
    var row = dataTableBody.querySelector('tr[data-idx="'+idx+'"]');
    if (!row) return;
    var cells = row.querySelectorAll('td');
    // 0=check 1=firstName 2=lastName 3=url 4=jobTitle 5=company 6=school 7=major
    if (cells[4]) cells[4].textContent = contact.jobTitle  || '';
    if (cells[5]) cells[5].textContent = contact.company   || '';
    if (cells[6]) cells[6].textContent = contact.school    || '';
    if (cells[7]) cells[7].textContent = contact.major     || '';
    row.classList.remove('row--enriching');
    row.classList.add('row--enriched');
  }

  // ── Export CSV ─────────────────────────────────────────────────────────
  if (btnExportCSV) {
    btnExportCSV.addEventListener('click', function() {
      chrome.storage.local.get(['crm_contacts'], function(data) {
        var contacts = data.crm_contacts || [];
        if (!contacts.length) { alert('No contacts to export.'); return; }
        downloadTSV(contacts);
      });
    });
  }

  function downloadTSV(contacts) {
    function clean(v) { return String(v||'').replace(/\t/g,' ').replace(/\r?\n/g,' '); }
    var lines = [['First Name','Last Name','URL','Job Title','Company','School','Major'].join('\t')].concat(
      contacts.map(function(c) {
        return [clean(c.firstName), clean(c.lastName), clean(c.profileUrl),
                clean(c.jobTitle), clean(c.company), clean(c.school), clean(c.major)].join('\t');
      })
    );
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/tab-separated-values;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = 'linkedin_leads_' + new Date().toISOString().slice(0,10) + '.tsv';
    a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
  }

  // ── FAQ accordion ─────────────────────────────────────────────────────
  document.querySelectorAll('.faq__question').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      document.querySelectorAll('.faq__question[aria-expanded="true"]').forEach(function(other) {
        if (other === btn) return;
        other.setAttribute('aria-expanded','false');
        var a = document.getElementById(other.getAttribute('aria-controls'));
        if (a) a.hidden = true;
      });
      btn.setAttribute('aria-expanded', String(!expanded));
      var answer = document.getElementById(btn.getAttribute('aria-controls'));
      if (answer) answer.hidden = expanded;
    });
  });

  // Initial load
  chrome.storage.local.get(['crm_contacts'], function(data) {
    tableContacts = data.crm_contacts || [];
    if (btnExportCSV) btnExportCSV.disabled = tableContacts.length === 0;
  });

})();