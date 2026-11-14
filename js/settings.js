import { applyUserPreferences, initAsciiSineWaves, initTopPanel } from "./ui.js";
import { STORAGE_KEYS, getUserPreferences, setUserLang, t } from "./data.js";

document.addEventListener("DOMContentLoaded", () => {
  applyUserPreferences();
  initTopPanel();
  initAsciiSineWaves();
  renderSettingsPage();
});

function renderSettingsPage() {
  const container = document.getElementById("settings-content");
  if (!container) return;

  const prefs = getUserPreferences();
  const dict = t();

  document.title = dict.pageTitleSettings;

  const backLink = document.getElementById("back-link");
  if (backLink) {
    backLink.textContent = dict.backToFeed;
  }

  container.innerHTML = "";

  // 1. Блок выбора языка
  const langBlock = createBlock(dict.settings.langLabel);
  const langOptions = document.createElement("div");
  langOptions.className = "settings-options";

  const languages = [
    { code: "ru", label: "ru // русский" },
    { code: "en", label: "en // english" },
    { code: "zh", label: "zh // 中文" }
  ];

  for (const item of languages) {
    const btn = createTermButton(item.label, prefs.lang === item.code, () => {
      setUserLang(item.code);
      applyUserPreferences();
      renderSettingsPage();
    });
    langOptions.appendChild(btn);
  }
  langBlock.appendChild(langOptions);
  container.appendChild(langBlock);

  // 2. Блок выбора темы оформления
  const themeBlock = createBlock(dict.settings.themeLabel);
  const themeOptions = document.createElement("div");
  themeOptions.className = "settings-options";

  const themeKeys = ["dark", "light", "amber", "phosphor"];
  for (const key of themeKeys) {
    const label = dict.settings.themes[key] || key;
    const btn = createTermButton(label, prefs.theme === key, () => {
      try {
        localStorage.setItem(STORAGE_KEYS.THEME, key);
      } catch {}
      applyUserPreferences();
      renderSettingsPage();
    });
    themeOptions.appendChild(btn);
  }
  themeBlock.appendChild(themeOptions);
  container.appendChild(themeBlock);

  // 3. Блок управления боковыми ASCII-волнами
  const asciiBlock = createBlock(dict.settings.asciiLabel);
  const asciiOptions = document.createElement("div");
  asciiOptions.className = "settings-options";

  const asciiStates = [
    { value: "on", label: dict.settings.asciiOn },
    { value: "off", label: dict.settings.asciiOff }
  ];

  for (const state of asciiStates) {
    const btn = createTermButton(state.label, prefs.ascii === state.value, () => {
      try {
        localStorage.setItem(STORAGE_KEYS.ASCII, state.value);
      } catch {}
      applyUserPreferences();
      renderSettingsPage();
    });
    asciiOptions.appendChild(btn);
  }
  asciiBlock.appendChild(asciiOptions);
  container.appendChild(asciiBlock);

  // 4. Блок пользовательского CSS
  const cssBlock = createBlock(dict.settings.customCssLabel);

  const hint = document.createElement("p");
  hint.className = "settings-hint";
  hint.textContent = dict.settings.customCssHint;
  cssBlock.appendChild(hint);

  const textarea = document.createElement("textarea");
  textarea.className = "custom-css-area";
  textarea.placeholder = dict.settings.customCssPlaceholder;
  textarea.value = prefs.customCss;
  textarea.spellcheck = false;
  cssBlock.appendChild(textarea);

  const cssActions = document.createElement("div");
  cssActions.className = "settings-options";

  const applyBtn = createTermButton(dict.settings.applyCss, false, () => {
    try {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_CSS, textarea.value);
    } catch {}
    applyUserPreferences();
    flashButtonText(applyBtn, dict.settings.savedToast, dict.settings.applyCss);
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".css,text/css";
  fileInput.className = "file-input-hidden";

  const uploadBtn = createTermButton(dict.settings.uploadCss, false, () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      textarea.value = text;
      localStorage.setItem(STORAGE_KEYS.CUSTOM_CSS, text);
      applyUserPreferences();
      flashButtonText(uploadBtn, dict.settings.savedToast, dict.settings.uploadCss);
    } catch (err) {
      console.warn("Ошибка чтения CSS-файла:", err);
    } finally {
      fileInput.value = "";
    }
  });

  const resetBtn = createTermButton(dict.settings.resetCss, false, () => {
    textarea.value = "";
    try {
      localStorage.removeItem(STORAGE_KEYS.CUSTOM_CSS);
    } catch {}
    applyUserPreferences();
  });

  cssActions.appendChild(applyBtn);
  cssActions.appendChild(uploadBtn);
  cssActions.appendChild(resetBtn);
  cssActions.appendChild(fileInput);

  cssBlock.appendChild(cssActions);
  container.appendChild(cssBlock);
}

function createBlock(labelText) {
  const block = document.createElement("div");
  block.className = "settings-block";

  const label = document.createElement("span");
  label.className = "settings-label";
  label.textContent = labelText;

  block.appendChild(label);
  return block;
}

function createTermButton(text, isActive, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "term-btn" + (isActive ? " active" : "");
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

function flashButtonText(btn, tempText, originalText) {
  btn.textContent = tempText;
  btn.classList.add("active");
  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove("active");
  }, 900);
}