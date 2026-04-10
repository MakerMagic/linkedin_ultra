/**
 * profile_scraper.js — LinkedIn CRM v2.5
 * Injected AFTER background.js runs fixed 5×600ms scroll.
 * Task: parse only — no scroll here.
 */
(function () {
  'use strict';

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], .sr-only, .visually-hidden').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function waitForSections(timeoutMs) {
    return new Promise(resolve => {
      function isReady() {
        if (document.querySelector('[componentKey*="Experience"],[componentkey*="experience"]')) return true;
        if (document.querySelector('[componentKey*="Education"],[componentkey*="education"]'))  return true;
        if (document.querySelector('#experience,#education')) return true;
        return Array.from(document.querySelectorAll('h2,h3')).some(h => {
          const t = (h.textContent || '').trim().toLowerCase();
          return t === 'опыт' || t === 'опыт работы' || t === 'образование' || t === 'experience' || t === 'education';
        });
      }
      if (isReady()) { resolve(); return; }
      let done = false;
      function finish() { if (done) return; done = true; clearInterval(p); obs.disconnect(); clearTimeout(t); resolve(); }
      const p   = setInterval(() => { if (isReady()) finish(); }, 300);
      const obs = new MutationObserver(() => { if (isReady()) finish(); });
      obs.observe(document.body, { childList: true, subtree: true });
      const t   = setTimeout(finish, timeoutMs || 8000);
    });
  }

  function findSections() {
    let exp = null, edu = null;
    for (const el of document.querySelectorAll('[componentKey],[componentkey]')) {
      const ck = (el.getAttribute('componentKey') || el.getAttribute('componentkey') || '').toLowerCase();
      if (!exp && ck.includes('experience')) { exp = el; console.log('[Scraper] ✅ Experience (componentKey)'); }
      if (!edu && ck.includes('education'))  { edu = el; console.log('[Scraper] ✅ Education (componentKey)'); }
    }
    if (!exp || !edu) {
      for (const h of document.querySelectorAll('h2,h3,[id]')) {
        const text = (h.textContent || '').trim().toLowerCase();
        const id   = (h.id || '').toLowerCase();
        if (!exp && (text === 'опыт' || text === 'опыт работы' || text === 'experience' || id === 'experience' || id.includes('experience'))) {
          exp = h.closest('section') || h.parentElement?.parentElement || h;
          console.log('[Scraper] ✅ Experience (heading)');
        }
        if (!edu && (text === 'образование' || text === 'education' || id === 'education' || id.includes('education'))) {
          edu = h.closest('section') || h.parentElement?.parentElement || h;
          console.log('[Scraper] ✅ Education (heading)');
        }
      }
    }
    return { experienceSection: exp, educationSection: edu };
  }

  function isIconLink(a) {
    return !!(a.querySelector('svg') || a.querySelector('img')) && !a.querySelector('p');
  }

  function getTargetLink(section) {
    if (!section) return null;
    const meaningful = Array.from(section.querySelectorAll('a')).filter(a => !isIconLink(a));
    if (meaningful.length === 0) return null;
    return meaningful.length >= 2 ? meaningful[1] : meaningful[0];
  }

  function scrapeProfile() {
    let jobTitle = '', company = '', school = '', major = '';
    const { experienceSection, educationSection } = findSections();

    if (experienceSection) {
      const link = getTargetLink(experienceSection);
      if (link) {
        const paras = Array.from(link.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
        if (paras[0]) jobTitle = paras[0];
        if (paras[1]) company  = paras[1];
        console.log('[Scraper] Experience →', { jobTitle, company });
      }
    }
    if (educationSection) {
      const link = getTargetLink(educationSection);
      if (link) {
        const paras = Array.from(link.querySelectorAll('p')).map(p => cleanText(p)).filter(Boolean);
        if (paras[0]) school = paras[0];
        if (paras[1]) major  = paras[1];
        console.log('[Scraper] Education →', { school, major });
      }
    }
    if (!jobTitle && !company && !school) {
      const el = document.querySelector('.pv-text-details__left-panel .text-body-medium') ||
                 document.querySelector('.ph5 .text-body-medium');
      if (el) {
        const text = cleanText(el);
        const atIdx = text.toLowerCase().indexOf(' at ');
        if (atIdx !== -1) { jobTitle = text.slice(0, atIdx).trim(); company = text.slice(atIdx+4).trim(); }
        else if (text) jobTitle = text;
      }
    }
    const result = { jobTitle: jobTitle||'', company: company||'', school: school||'', major: major||'' };
    console.log('[Scraper] ✅ Result:', result);
    return result;
  }

  (async () => {
    await waitForSections(8000);
    await new Promise(r => setTimeout(r, 400));
    const result = scrapeProfile();
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'PROFILE_DATA', data: result, url: location.href })
        .catch(err => console.warn('[Scraper] sendMessage error:', err));
    }
  })();

})();