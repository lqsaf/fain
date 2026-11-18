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

  // 1. Интерфейс (Interface)
  const interfaceSection = createSection(dict.settings.interfaceSection);
  
  // Theme
  const themeSelect = createSelect(
    dict.settings.themeLabel,
    ["dark", "light", "amber", "phosphor"],
    key => dict.settings.themes[key],
    prefs.theme,
    val => {
      try {
        localStorage.setItem(STORAGE_KEYS.THEME, val);
      } catch {}
      applyUserPreferences();
      renderSettingsPage();
    }
  );
  interfaceSection.appendChild(themeSelect);

  // ASCII
  const asciiSelect = createSelect(
    dict.settings.asciiLabel,
    ["on", "off"],
    val => (val === "on" ? dict.settings.asciiOn : dict.settings.asciiOff),
    prefs.ascii,
    val => {
      try {
        localStorage.setItem(STORAGE_KEYS.ASCII, val);
      } catch {}
      applyUserPreferences();
      renderSettingsPage();
    }
  );
  interfaceSection.appendChild(asciiSelect);
  
  container.appendChild(interfaceSection);

  // 2. Язык (Language)
  const langSection = createSection(dict.settings.languageSection);
  
  const langSelect = createSelect(
    dict.settings.langLabel,
    ["ru", "en", "zh"],
    val => ({ ru: "ru // русский", en: "en // english", zh: "zh // 中文" }[val]),
    prefs.lang,
    val => {
      setUserLang(val);
      applyUserPreferences();
      renderSettingsPage();
    }
  );
  langSection.appendChild(langSelect);
  
  container.appendChild(langSection);

  // 3. Прочее (Other)
  const otherSection = createSection(dict.settings.otherSection);
  
  // Custom CSS (Keep textarea as requested)
  const cssLabel = document.createElement("label");
  cssLabel.className = "settings-label";
  cssLabel.textContent = dict.settings.customCssLabel;
  otherSection.appendChild(cssLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "custom-css-area";
  textarea.placeholder = dict.settings.customCssPlaceholder;
  textarea.value = prefs.customCss;
  textarea.spellcheck = false;
  otherSection.appendChild(textarea);

  const cssActions = document.createElement("div");
  cssActions.className = "settings-options";

  const applyBtn = createTermButton(dict.settings.applyCss, false, () => {
    try {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_CSS, textarea.value);
    } catch {}
    applyUserPreferences();
    flashButtonText(applyBtn, dict.settings.savedToast, dict.settings.applyCss);
  });

  const uploadBtn = createTermButton(dict.settings.uploadCss, false, () => {
    fileInput.click();
  });

  const resetBtn = createTermButton(dict.settings.resetCss, false, () => {
    textarea.value = "";
    try {
      localStorage.removeItem(STORAGE_KEYS.CUSTOM_CSS);
    } catch {}
    applyUserPreferences();
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".css,text/css";
  fileInput.className = "file-input-hidden";
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

  cssActions.appendChild(applyBtn);
  cssActions.appendChild(uploadBtn);
  cssActions.appendChild(resetBtn);
  cssActions.appendChild(fileInput);

  otherSection.appendChild(cssActions);
  container.appendChild(otherSection);
}

function createSection(title) {
  const section = document.createElement("div");
  section.className = "settings-block";
  
  const header = document.createElement("h2");
  header.className = "settings-label";
  header.textContent = title;
  header.style.fontSize = "0.9rem";
  header.style.marginBottom = "20px";
  header.style.textTransform = "uppercase";
  
  section.appendChild(header);
  return section;
}

function createSelect(labelText, options, labelFn, currentVal, onChange) {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-block";
  wrapper.style.padding = "10px 0";
  wrapper.style.borderBottom = "none";

  const label = document.createElement("label");
  label.className = "settings-label";
  label.textContent = labelText;
  label.style.marginBottom = "6px";
  wrapper.appendChild(label);

  const select = document.createElement("select");
  select.className = "term-select";
  
  options.forEach(opt => {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = labelFn(opt);
    if (opt === currentVal) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener("change", e => {
    onChange(e.target.value);
  });

  wrapper.appendChild(select);
  return wrapper;
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