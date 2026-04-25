/**
 * networking_scroll.js — LinkedIn CRM
 *
 * НАЗНАЧЕНИЕ:
 *   Этот файл — content script. Он автоматически запускается браузером
 *   когда пользователь открывает страницу linkedin.com/mynetwork/grow/
 *   Он не требует никакого вызова из dashboard.js или background.js —
 *   браузер сам его инжектирует согласно manifest.json.
 *
 * ЧТО ДЕЛАЕТ:
 *   1. Ждёт 2 секунды (страница LinkedIn SPA грузится асинхронно)
 *   2. Скроллит вниз шагами 400–900px
 *   3. Между шагами делает случайную паузу 1–3 секунды (анти-детект)
 *   4. Останавливается когда достигнут конец страницы
 *      (3 раза подряд scrollTop не изменился = конец)
 *
 * АНТИ-ДЕТЕКТ:
 *   - Случайный размер шага (randomInt)
 *   - Случайная пауза между шагами (1000–3000ms)
 *   - Проверка "stuck" — не скроллит бесконечно если достиг дна
 */

(function () {
  'use strict';

  // ── Настройки скролла ─────────────────────────────────────────────────

  const CFG = {
    initialDelayMs: 2000,
    pauseMinMs: 1000,
    pauseMaxMs: 3000,
    scrollStepMin: 400,
    scrollStepMax: 900,
    maxStuckCycles: 3
  };

  // ── Утилиты ───────────────────────────────────────────────────────────

  function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Основной скролл ───────────────────────────────────────────────────

  async function performMaxScroll() {
    console.log('[CRM Networking Scroll] Старт скролла страницы grow...');

    await delay(CFG.initialDelayMs);

    const scrollEl = document.scrollingElement || document.documentElement;

    let stuckCycles = 0;
    let lastScrollTop = -1;
    let stepCount = 0;

    while (stuckCycles < CFG.maxStuckCycles) {
      const currentScrollTop = scrollEl.scrollTop;
      const scrollHeight = scrollEl.scrollHeight;
      const clientHeight = scrollEl.clientHeight;

      if (currentScrollTop + clientHeight >= scrollHeight - 5) {
        console.log('[CRM Networking Scroll] ✅ Достигнут конец страницы');
        break;
      }

      if (currentScrollTop === lastScrollTop) {
        stuckCycles++;
        console.log(`[CRM Networking Scroll] Скролл не двигается (${stuckCycles}/${CFG.maxStuckCycles})`);
      } else {
        stuckCycles = 0;
      }

      lastScrollTop = currentScrollTop;

      const step = randomInt(CFG.scrollStepMin, CFG.scrollStepMax);
      scrollEl.scrollTop += step;
      stepCount++;

      console.log(
        `[CRM Networking Scroll] Шаг ${stepCount}: +${step}px | ` +
        `${Math.round(scrollEl.scrollTop)} / ${scrollHeight}px`
      );

      const pause = randomInt(CFG.pauseMinMs, CFG.pauseMaxMs);
      await delay(pause);
    }

    console.log(`[CRM Networking Scroll] ✅ Завершено. Всего шагов: ${stepCount}`);
  }

  // ── Запуск ────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', performMaxScroll);
  } else {
    performMaxScroll();
  }
})();
