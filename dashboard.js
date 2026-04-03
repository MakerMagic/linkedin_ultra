/**
 * Только UI вкладки «Синхронизация». Без сети и бэкенда.
 */
(function () {
  const CIRC = 2 * Math.PI * 52;
  const arc = document.getElementById("progressArc");
  const pctEl = document.getElementById("progressPercent");
  const statusEl = document.getElementById("syncStatus");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");

  let stubPercent = 0;

  function setProgress(p) {
    stubPercent = Math.max(0, Math.min(100, p));
    if (arc) {
      arc.style.strokeDasharray = String(CIRC);
      arc.style.strokeDashoffset = String(CIRC * (1 - stubPercent / 100));
    }
    if (pctEl) {
      pctEl.textContent = String(Math.round(stubPercent));
    }
  }

  function setRunning(running) {
    btnStart.disabled = running;
    btnStop.disabled = !running;
    statusEl.textContent = running ? "Синхронизация (демо)…" : "Ожидание запуска";
  }

  btnStart.addEventListener("click", () => {
    setRunning(true);
    setProgress(0);
  });

  btnStop.addEventListener("click", () => {
    setRunning(false);
    setProgress(0);
  });

  setProgress(0);
})();
