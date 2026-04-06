/**
 * profile_scraper.js — LinkedIn CRM v2.0
 * Инжектируется в фоновую вкладку профиля.
 * Только чтение DOM — никаких мутаций.
 */
(function () {
  'use strict';

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.sr-only, .visually-hidden, [class*="visually-hidden"]').forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isSchool(text) {
    return /university|college|school|institute|academy|polytechnic|seminary|лицей|колледж|университет|институт|академия/i.test(text);
  }

  function scrapeProfile() {
    let jobTitle = null, company = null, school = null;

    const allSections = document.querySelectorAll('[componentKey], [componentkey]');
    for (const section of allSections) {
      const ck = section.getAttribute('componentKey') || section.getAttribute('componentkey') || '';
      const isExp = /ExperienceTopLevelSection/i.test(ck);
      const isEdu = /EducationTopLevelSection/i.test(ck);
      if (!isExp && !isEdu) continue;

      const boldEls = section.querySelectorAll('p[class*="ba487acf"]');
      const subEls  = section.querySelectorAll('p[class*="dd3e351e"]');

      if (isExp) {
        const boldEl = boldEls[0];
        if (boldEl && !jobTitle) {
          const t = cleanText(boldEl);
          if (t) { if (isSchool(t) && !school) school = t; else jobTitle = t; }
        }
        const subEl = subEls[0];
        if (subEl && !company) { const c = cleanText(subEl); if (c) company = c; }
      }

      if (isEdu) {
        const schoolEl = boldEls[0];
        if (schoolEl && !school) { const s = cleanText(schoolEl); if (s) school = s; }
      }
    }

    // Fallback
    if (!jobTitle && !company && !school) {
      const el =
        document.querySelector('.pv-text-details__left-panel .text-body-medium') ||
        document.querySelector('.ph5 .text-body-medium') ||
        document.querySelector('[class*="text-body-medium"]');
      if (el) {
        const text = cleanText(el);
        const atIdx = text.toLowerCase().indexOf(' at ');
        if (atIdx !== -1) {
          const title = text.slice(0, atIdx).trim();
          const org   = text.slice(atIdx + 4).trim();
          if (isSchool(org)) { jobTitle = title || null; school = org; }
          else { jobTitle = title || null; company = org; }
        } else if (isSchool(text)) { school = text; }
        else if (text) { jobTitle = text; }
      }
    }

    return { jobTitle: jobTitle || null, company: company || null, school: school || null };
  }

  function waitForContent(timeoutMs) {
    return new Promise(resolve => {
      if (document.querySelector('[componentKey], [componentkey]') ||
          document.querySelector('.pv-text-details__left-panel')) { resolve(); return; }
      const obs   = new MutationObserver(() => {
        if (document.querySelector('[componentKey], [componentkey]') ||
            document.querySelector('.pv-text-details__left-panel')) {
          obs.disconnect(); clearTimeout(timer); resolve();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); resolve(); }, timeoutMs || 8000);
    });
  }

  (async () => {
    await waitForContent();
    await new Promise(r => setTimeout(r, 800));
    const result = scrapeProfile();
    console.log('[CRM Scraper]', result);
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'PROFILE_DATA', data: result, url: location.href }).catch(() => {});
    }
  })();
})();