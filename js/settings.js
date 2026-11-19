import { applyUserPreferences, initAsciiSineWaves, initTopPanel } from "./ui.js";
import { STORAGE_KEYS, getUserPreferences, setUserLang, t } from "./data.js";

document.addEventListener("click", closeDropdownOnOutside);

document.addEventListener("DOMContentLoaded", () => {
  applyUserPreferences();
  initTopPanel();
  initAsciiSineWaves();
  renderSettingsPage();
});

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function renderSettingsPage() {
  const container = document.getElementById("settings-content");
  if (!container) return;
  const prefs = getUserPreferences();
  const dict = t();
  document.title = dict.pageTitleSettings;
  const backLink = document.getElementById("back-link");
  if (backLink) backLink.textContent = dict.backToFeed;

  let openSections = ["interface"];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS_SECTIONS));
    if (Array.isArray(saved) && saved.every(value => ["interface", "language", "other"].includes(value))) openSections = saved;
  } catch {}
  container.replaceChildren();
  const interfaceSection = createSection(dict.settings.interfaceSection, "interface", openSections);
  interfaceSection.append(
    createSelect(dict.settings.themeLabel, ["dark", "light", "amber", "phosphor"], key => dict.settings.themes[key], prefs.theme, value => {
      writeSetting(STORAGE_KEYS.THEME, value); applyUserPreferences();
    }),
    createSelect(dict.settings.scaleLabel, ["small", "normal", "large"], key => dict.settings.scales[key], readSetting(STORAGE_KEYS.SCALE, "normal"), value => {
      writeSetting(STORAGE_KEYS.SCALE, value); document.documentElement.dataset.scale = value;
    }),
    createSelect(dict.settings.fontLabel, ["mono", "system"], key => dict.settings.fonts[key], readSetting(STORAGE_KEYS.FONT, "mono"), value => {
      writeSetting(STORAGE_KEYS.FONT, value); document.documentElement.dataset.font = value;
    }),
    createSelect(dict.settings.asciiLabel, ["on", "off"], value => value === "on" ? dict.settings.asciiOn : dict.settings.asciiOff, prefs.ascii, value => {
      writeSetting(STORAGE_KEYS.ASCII, value); applyUserPreferences();
    })
  );
  container.appendChild(interfaceSection);

  const languageSection = createSection(dict.settings.languageSection, "language", openSections);
  languageSection.appendChild(createSelect(dict.settings.langLabel, ["ru", "en", "zh"], value => ({ ru: "ru // русский", en: "en // english", zh: "zh // 中文" }[value]), prefs.lang, value => {
    setUserLang(value); renderSettingsPage(); applyUserPreferences();
  }));
  container.appendChild(languageSection);

  const otherSection = createSection(dict.settings.otherSection, "other", openSections);
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
  const actions = document.createElement("div");
  actions.className = "settings-options";
  const applyBtn = createTermButton(dict.settings.applyCss, false, () => {
    writeSetting(STORAGE_KEYS.CUSTOM_CSS, textarea.value); applyUserPreferences(); flashButtonText(applyBtn, dict.settings.savedToast, dict.settings.applyCss);
  });
  const uploadBtn = createTermButton(dict.settings.uploadCss, false, () => fileInput.click());
  const resetBtn = createTermButton(dict.settings.resetCss, false, () => {
    textarea.value = "";
    try { localStorage.removeItem(STORAGE_KEYS.CUSTOM_CSS); } catch {}
    applyUserPreferences();
  });
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = ".css,text/css"; fileInput.className = "file-input-hidden";
  fileInput.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text(); textarea.value = text; writeSetting(STORAGE_KEYS.CUSTOM_CSS, text);
      applyUserPreferences(); flashButtonText(uploadBtn, dict.settings.savedToast, dict.settings.uploadCss);
    } catch (error) { console.warn("Ошибка чтения CSS-файла:", error); }
    finally { fileInput.value = ""; }
  });
  actions.append(applyBtn, uploadBtn, resetBtn, fileInput);
  otherSection.appendChild(actions);
  container.appendChild(otherSection);
}

function createSection(title, key, openSections) {
  const section = document.createElement("section");
  section.className = "settings-accordion";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-accordion-trigger";
  button.textContent = title;
  button.id = `settings-heading-${key}`;
  const panel = document.createElement("div");
  panel.className = "settings-accordion-panel";
  panel.id = `settings-panel-${key}`;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", button.id);
  let open = openSections.includes(key);
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  panel.inert = !open;
  button.addEventListener("click", () => {
    open = !open; button.setAttribute("aria-expanded", String(open));
    if (open) { panel.hidden = false; panel.inert = false; }
    else { panel.inert = true; panel.style.maxHeight = `${panel.scrollHeight}px`; requestAnimationFrame(() => { panel.style.maxHeight = "0px"; }); }
    if (open) { panel.style.maxHeight = `${panel.scrollHeight}px`; panel.addEventListener("transitionend", () => { panel.style.maxHeight = ""; }, { once: true }); }
    const opened = [...document.querySelectorAll(".settings-accordion-trigger[aria-expanded=true]")].map(item => item.dataset.key);
    try { localStorage.setItem(STORAGE_KEYS.SETTINGS_SECTIONS, JSON.stringify(opened)); } catch {}
  });
  button.dataset.key = key;
  section.append(button, panel);
  return panel;
}

function createSelect(labelText, options, labelFn, currentVal, onChange) {
  const wrapper = document.createElement("div");
  wrapper.className = "settings-control";
  const label = document.createElement("span");
  label.className = "settings-label";
  label.textContent = labelText;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "term-select-trigger";
  trigger.setAttribute("aria-label", labelText);
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const list = document.createElement("div");
  list.className = "term-select-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  let selected = options.indexOf(currentVal);
  let active = selected;
  const optionsEls = options.map((value, index) => {
    const option = document.createElement("button");
    option.type = "button"; option.className = "term-select-option";
    option.setAttribute("role", "option"); option.dataset.value = value;
    option.setAttribute("aria-selected", String(index === selected)); option.textContent = labelFn(value);
    option.addEventListener("click", () => choose(index));
    list.appendChild(option); return option;
  });
  function update() {
    trigger.textContent = labelFn(options[selected]);
    optionsEls.forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === selected));
      option.tabIndex = index === active ? 0 : -1;
    });
  }
  function open(index = selected) {
    active = Math.max(0, index); list.hidden = false; trigger.setAttribute("aria-expanded", "true");
    optionsEls[active].focus();
  }
  function close(returnFocus = true) {
    list.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  }
  function choose(index) {
    selected = index; active = index; update(); onChange(options[index]); close();
  }
  trigger.addEventListener("click", () => list.hidden ? open() : close(false));
  trigger.addEventListener("keydown", event => {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(event.key === "ArrowUp" ? options.length - 1 : selected); }
  });
  list.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); active = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      update(); optionsEls[active].focus();
    }
  });
  wrapper.append(label, trigger, list); update();
  return wrapper;
}

function closeDropdownOnOutside(event) {
  document.querySelectorAll(".settings-control").forEach(control => {
    if (!control.contains(event.target)) {
      const trigger = control.querySelector("[role=combobox]");
      const list = control.querySelector("[role=listbox]");
      if (list && !list.hidden) { list.hidden = true; trigger.setAttribute("aria-expanded", "false"); }
    }
  });
}

function createTermButton(text, isActive, onClick) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "term-btn" + (isActive ? " active" : ""); button.textContent = text; button.addEventListener("click", onClick);
  return button;
}
function flashButtonText(button, temporary, original) {
  button.textContent = temporary; button.classList.add("active");
  setTimeout(() => { button.textContent = original; button.classList.remove("active"); }, 900);
}
