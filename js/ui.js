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

      // В самом верху страницы панель всегда видна
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

// Отрисовка боковых ASCII синусоидных графиков для ПК
export function initAsciiSineWaves() {
  const leftEl = document.getElementById("ascii-left");
  const rightEl = document.getElementById("ascii-right");
  if (!leftEl || !rightEl) return;

  const width = 21;
  let phase = 0;
  let lastFrame = 0;

  function renderFrame(timestamp) {
    if (window.innerWidth <= 1120) {
      requestAnimationFrame(renderFrame);
      return;
    }

    // Ограничиваем частоту кадров ~18 FPS для спокойного терминального движения
    if (timestamp - lastFrame < 55) {
      requestAnimationFrame(renderFrame);
      return;
    }
    lastFrame = timestamp;

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
    phase += 0.09;

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}