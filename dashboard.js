/**
 * Панель LinkedIn CRM: навигация, синхронизация (UI), поиск (UI + контракт под AI).
 */
(function () {
  // ——— Навигация между разделами ———

  const navButtons = document.querySelectorAll(".nav__item[data-nav]:not([disabled])");
  const panels = document.querySelectorAll(".main-panel[data-panel]");

  /** Переключает основной контент по data-nav / data-panel */
  function setActiveView(viewId) {
    navButtons.forEach((btn) => {
      const id = btn.getAttribute("data-nav");
      const active = id === viewId;
      btn.classList.toggle("nav__item--active", active);
      if (active) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });

    panels.forEach((panel) => {
      const match = panel.getAttribute("data-panel") === viewId;
      panel.classList.toggle("main-panel--active", match);
    });

    document.title = viewId === "search" ? "LinkedIn CRM — Поиск" : "LinkedIn CRM — Синхронизация";
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-nav");
      if (!id) return;
      setActiveView(id);
    });
  });

  document.querySelectorAll("[data-go-sync]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveView("sync");
    });
  });

  // ——— Синхронизация (кольцо, демо-кнопки) ———

  const circumference = 2 * Math.PI * 52;
  const arc = document.getElementById("progressArc");
  const pctEl = document.getElementById("progressPercent");
  const statusEl = document.getElementById("syncStatus");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");

  let stubPercent = 0;

  function setProgress(p) {
    stubPercent = Math.max(0, Math.min(100, p));
    if (arc) {
      arc.style.strokeDasharray = String(circumference);
      arc.style.strokeDashoffset = String(circumference * (1 - stubPercent / 100));
    }
    if (pctEl) {
      pctEl.textContent = String(Math.round(stubPercent));
    }
  }

  function setRunning(running) {
    if (btnStart) btnStart.disabled = running;
    if (btnStop) btnStop.disabled = !running;
    if (statusEl) {
      statusEl.textContent = running ? "Синхронизация (демо)…" : "Ожидание запуска";
    }
  }

  if (btnStart && btnStop) {
    btnStart.addEventListener("click", () => {
      setRunning(true);
      setProgress(0);
    });
    btnStop.addEventListener("click", () => {
      setRunning(false);
      setProgress(0);
    });
    setProgress(0);
  }

  // ——— Поиск: отрасли (мультивыбор-теги) ———

  /** Значения id совпадают с будущим API */
  /** id — как в ТЗ; label — для отображения */
  const INDUSTRY_OPTIONS = [
    { id: "finance", label: "Финансы" },
    { id: "consulting", label: "Консалтинг" },
    { id: "tech", label: "Технологии" },
    { id: "ai_ml", label: "AI / ML" },
    { id: "healthcare", label: "Медицина" },
    { id: "energy", label: "Энергетика" },
    { id: "consumer", label: "Потребительский" },
    { id: "industrial", label: "Промышленность" },
    { id: "real_estate", label: "Недвижимость" },
    { id: "media", label: "Медиа" },
    { id: "education", label: "Образование" },
    { id: "venture_capital", label: "Венчур" },
    { id: "government", label: "Госсектор" },
    { id: "other", label: "Другое" }
  ];

  const industryRoot = document.getElementById("industryTags");
  const keywordsInput = document.getElementById("searchKeywords");

  if (industryRoot) {
    INDUSTRY_OPTIONS.forEach(({ id, label }) => {
      const wrap = document.createElement("label");
      wrap.className = "tag-select__item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "tag-select__input";
      input.value = id;
      input.setAttribute("data-industry", id);
      const pill = document.createElement("span");
      pill.className = "tag-select__pill";
      pill.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(pill);
      industryRoot.appendChild(wrap);
    });
  }

  function getSelectedIndustryIds() {
    if (!industryRoot) return [];
    return Array.from(industryRoot.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
  }

  /**
   * Контракт поискового запроса для следующих шагов (FastAPI / AI).
   * Поле keywords.semantic позволит подставить результат промпта без перестройки формы и фильтров.
   */
  function buildSearchPayload() {
    const raw = keywordsInput ? keywordsInput.value.trim() : "";
    return {
      schemaVersion: 1,
      keywords: {
        raw,
        /** Заполнит AI-интерпретация; UI на этом шаге не трогает */
        semantic: null
      },
      industries: getSelectedIndustryIds()
    };
  }

  /** Заглушка под будущий вызов API / AI */
  function stubExecuteSearch(_payload) {
    /* без сети */
  }

  const btnSearch = document.getElementById("btnSearch");
  if (btnSearch) {
    btnSearch.addEventListener("click", () => {
      const payload = buildSearchPayload();
      stubExecuteSearch(payload);
    });
  }
})();
