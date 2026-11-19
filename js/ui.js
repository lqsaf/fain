import { getUserPreferences } from "./data.js";

const CUSTOM_STYLE_ID = "fain-custom-css";

// Применяем тему, состояние ASCII-волн и пользовательский CSS из localStorage
export function applyUserPreferences() {
  const { lang, theme, ascii, customCss } = getUserPreferences();

  document.documentElement.lang = lang;
  document.documentElement.setAttribute("data-theme", theme);

  const leftEl = document.getElementById("ascii-left");
  const rightEl = document.getElementById("ascii-right");
  const isHidden = ascii === "off";

  if (leftEl) leftEl.classList.toggle("ascii-hidden", isHidden);
  if (rightEl) rightEl.classList.toggle("ascii-hidden", isHidden);

  let styleEl = document.getElementById(CUSTOM_STYLE_ID);
  if (customCss && customCss.trim() !== "") {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = CUSTOM_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = customCss;
  } else if (styleEl) {
    styleEl.remove();
  }
}

// Скрытие верхней панели при скролле вниз и показ при скролле вверх
export function initTopPanel() {
  const panel = document.getElementById("top-panel");
  if (!panel) return;

  let lastScrollY = window.scrollY;
  const deltaThreshold = 8;

  window.addEventListener(
    "scroll",
    () => {
      const currentScrollY = window.scrollY;

      if (currentScrollY <= 16) {
        panel.classList.remove("top-panel--hidden");
        lastScrollY = currentScrollY;
        return;
      }

      if (Math.abs(currentScrollY - lastScrollY) < deltaThreshold) {
        return;
      }

      if (currentScrollY > lastScrollY && currentScrollY > 48) {
        panel.classList.add("top-panel--hidden");
      } else {
        panel.classList.remove("top-panel--hidden");
      }

      lastScrollY = currentScrollY;
    },
    { passive: true }
  );
}

// Отрисовка боковых ASCII синусоидных графиков с единой фазой по системному времени
export function initAsciiSineWaves() {
  const leftEl = document.getElementById("ascii-left");
  const rightEl = document.getElementById("ascii-right");
  if (!leftEl || !rightEl) return;

  const width = 21;
  let lastFrame = 0;

  function drawWaves() {
    if (window.innerWidth <= 1120 || leftEl.classList.contains("ascii-hidden")) {
      return;
    }

    // Фаза привязана к реальному времени, чтобы волны не сбрасывались при смене страниц
    const phase = (Date.now() % 3600000) * 0.0016;
    const rows = Math.max(30, Math.floor(window.innerHeight / 13));
    let leftOut = "";
    let rightOut = "";

    const center = Math.floor(width / 2);
    const amplitude = Math.floor(width / 2) - 2;

    for (let y = 0; y < rows; y++) {
      const waveL1 = Math.round(center + Math.sin(y * 0.22 + phase) * amplitude);
      const waveL2 = Math.round(center + Math.cos(y * 0.11 - phase * 0.7) * (amplitude * 0.6));

      const waveR1 = Math.round(center + Math.sin(y * 0.22 - phase) * amplitude);
      const waveR2 = Math.round(center + Math.sin(y * 0.13 + phase * 0.8) * (amplitude * 0.6));

      let rowL = "";
      let rowR = "";

      for (let x = 0; x < width; x++) {
        if (x === waveL1) rowL += "•";
        else if (x === waveL2) rowL += "·";
        else rowL += " ";

        if (x === waveR1) rowR += "•";
        else if (x === waveR2) rowR += "·";
        else rowR += " ";
      }

      leftOut += rowL + "\n";
      rightOut += rowR + "\n";
    }

    leftEl.textContent = leftOut;
    rightEl.textContent = rightOut;
  }

  function renderFrame(timestamp) {
    if (timestamp - lastFrame >= 55) {
      lastFrame = timestamp;
      drawWaves();
    }
    requestAnimationFrame(renderFrame);
  }

  // Мгновенный первый кадр без ожидания следующего тика анимации
  drawWaves();
  requestAnimationFrame(renderFrame);
}