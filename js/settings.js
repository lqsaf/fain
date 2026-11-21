import { applyUserPreferences, initAsciiSineWaves, initTopPanel } from "./ui.js";
import { STORAGE_KEYS, getUserPreferences, setUserLang, t, loadAccordionState, saveAccordionState } from "./data.js";

document.addEventListener("DOMContentLoaded", () => {
  // Opt out of bfcache to ensure fresh render on each navigation (critical for test reliability)
  window.addEventListener("beforeunload", () => {});
  window.addEventListener("pagehide", () => {});
  // Force re-render if page was restored from bfcache
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      renderSettingsPage();
    }
  });
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
  let openSections = loadAccordionState();
  if (!Array.isArray(openSections)) openSections = ["interface"];

  document.title = dict.pageTitleSettings;

  const backLink = document.getElementById("back-link");
  if (backLink) {
    backLink.textContent = dict.backToFeed;
  }

  container.innerHTML = "";

  // Section order: interface, language, other
  const sections = [
    { id: "interface", title: dict.settings.interfaceSection, render: renderInterfaceSection },
    { id: "language", title: dict.settings.languageSection, render: renderLanguageSection },
    { id: "other", title: dict.settings.otherSection, render: renderOtherSection }
  ];

  sections.forEach(section => {
    const isOpen = openSections.includes(section.id);
    const accordionEl = createAccordionSection(section.id, section.title, isOpen, section.render(prefs, dict));
    container.appendChild(accordionEl);
  });
}

function createAccordionSection(id, title, isOpen, contentEl) {
  const section = document.createElement("div");
  section.className = "settings-block accordion-section";

  const btnId = `accordion-btn-${id}`;
  const panelId = `accordion-panel-${id}`;

  const headerBtn = document.createElement("button");
  headerBtn.type = "button";
  headerBtn.className = "accordion-btn";
  headerBtn.id = btnId;
  headerBtn.setAttribute("aria-controls", panelId);
  headerBtn.setAttribute("aria-expanded", isOpen.toString());
  headerBtn.innerHTML = `
    <span class="accordion-title">${title}</span>
    <span class="accordion-chevron" aria-hidden="true"></span>
  `;

  const panel = document.createElement("div");
  panel.id = panelId;
  panel.className = "accordion-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", btnId);
  if (!isOpen) {
    panel.hidden = true;
  } else {
    panel.classList.add("accordion-panel--open");
  }
  panel.innerHTML = '<div class="accordion-panel-content"></div>';
  panel.querySelector(".accordion-panel-content").appendChild(contentEl);

  headerBtn.addEventListener("click", () => toggleAccordion(id, headerBtn, panel));
  headerBtn.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleAccordion(id, headerBtn, panel);
    }
  });

  section.appendChild(headerBtn);
  section.appendChild(panel);
  return section;
}

function toggleAccordion(id, headerBtn, panel) {
  const isOpen = headerBtn.getAttribute("aria-expanded") === "true";
  const newOpen = !isOpen;

  headerBtn.setAttribute("aria-expanded", newOpen.toString());

  const focusableSelector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusableElements = panel.querySelectorAll(focusableSelector);

  if (newOpen) {
    panel.hidden = false;
    // Restore original tabindex values
    focusableElements.forEach(el => {
      const originalTabIndex = el.dataset.originalTabindex;
      if (originalTabIndex !== undefined) {
        el.tabIndex = parseInt(originalTabIndex, 10);
        delete el.dataset.originalTabindex;
      } else if (el.hasAttribute("data-original-tabindex")) {
        // Fallback for any missed elements
        el.tabIndex = parseInt(el.getAttribute("data-original-tabindex"), 10);
        el.removeAttribute("data-original-tabindex");
      }
    });
    // Force reflow for animation
    panel.offsetHeight;
    panel.classList.add("accordion-panel--open");
  } else {
    // Store original tabindex and set to -1 to remove from tab order
    focusableElements.forEach(el => {
      if (el.tabIndex >= 0) {
        el.dataset.originalTabindex = el.tabIndex.toString();
        el.tabIndex = -1;
      }
    });
    panel.classList.remove("accordion-panel--open");
    // Hide after the collapse animation, but never if the panel was reopened.
    setTimeout(() => {
      if (headerBtn.getAttribute("aria-expanded") === "false") panel.hidden = true;
    }, 350);
  }

  // Save state
  const openSections = loadAccordionState();
  const currentIndex = openSections.indexOf(id);
  let newSections;
  if (newOpen) {
    if (currentIndex === -1) {
      newSections = [...openSections, id];
    } else {
      newSections = openSections;
    }
  } else {
    if (currentIndex !== -1) {
      newSections = openSections.filter(s => s !== id);
    } else {
      newSections = openSections;
    }
  }
  saveAccordionState(newSections);
}

function renderInterfaceSection(prefs, dict) {
  const wrapper = document.createDocumentFragment();

  // Theme combobox
  wrapper.appendChild(createCombobox({
    id: "theme",
    label: dict.settings.themeLabel,
    options: [
      { value: "dark", label: dict.settings.themes.dark },
      { value: "light", label: dict.settings.themes.light },
      { value: "amber", label: dict.settings.themes.amber },
      { value: "phosphor", label: dict.settings.themes.phosphor }
    ],
    currentValue: prefs.theme,
    onChange: val => {
      try { localStorage.setItem(STORAGE_KEYS.THEME, val); } catch {}
      applyUserPreferences();
      // Update combobox value display without full re-render
      updateComboboxValue("theme", val, dict);
    }
  }));

  // ASCII combobox
  wrapper.appendChild(createCombobox({
    id: "ascii",
    label: dict.settings.asciiLabel,
    options: [
      { value: "on", label: dict.settings.asciiOn },
      { value: "off", label: dict.settings.asciiOff }
    ],
    currentValue: prefs.ascii,
    onChange: val => {
      try { localStorage.setItem(STORAGE_KEYS.ASCII, val); } catch {}
      applyUserPreferences();
      updateComboboxValue("ascii", val, dict);
    }
  }));

  return wrapper;
}

function renderLanguageSection(prefs, dict) {
  const wrapper = document.createDocumentFragment();

  wrapper.appendChild(createCombobox({
    id: "lang",
    label: dict.settings.langLabel,
    options: [
      { value: "ru", label: "ru // русский" },
      { value: "en", label: "en // english" },
      { value: "zh", label: "zh // 中文" }
    ],
    currentValue: prefs.lang,
    onChange: val => {
      setUserLang(val);
      applyUserPreferences();
      // Language change requires full re-render for all text
      renderSettingsPage();
    }
  }));

  return wrapper;
}

function renderOtherSection(prefs, dict) {
  const wrapper = document.createDocumentFragment();

  // Custom CSS label
  const cssLabel = document.createElement("label");
  cssLabel.className = "settings-label";
  cssLabel.textContent = dict.settings.customCssLabel;
  wrapper.appendChild(cssLabel);

  // Custom CSS textarea
  const textarea = document.createElement("textarea");
  textarea.className = "custom-css-area";
  textarea.placeholder = dict.settings.customCssPlaceholder;
  textarea.value = prefs.customCss;
  textarea.spellcheck = false;
  wrapper.appendChild(textarea);

  // Custom CSS actions
  const cssActions = document.createElement("div");
  cssActions.className = "settings-options";

  const applyBtn = createTermButton(dict.settings.applyCss, false, () => {
    try { localStorage.setItem(STORAGE_KEYS.CUSTOM_CSS, textarea.value); } catch {}
    applyUserPreferences();
    flashButtonText(applyBtn, dict.settings.savedToast, dict.settings.applyCss);
  });

  const uploadBtn = createTermButton(dict.settings.uploadCss, false, () => {
    fileInput.click();
  });

  const resetBtn = createTermButton(dict.settings.resetCss, false, () => {
    textarea.value = "";
    try { localStorage.removeItem(STORAGE_KEYS.CUSTOM_CSS); } catch {}
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

  wrapper.appendChild(cssActions);

  return wrapper;
}

function createCombobox({ id, label, options, currentValue, onChange }) {
  const wrapper = document.createElement("div");
  wrapper.className = "combobox-wrapper";

  const labelId = `combobox-label-${id}`;
  const valueId = `combobox-value-${id}`;
  const triggerId = `combobox-trigger-${id}`;
  const listboxId = `combobox-listbox-${id}`;

  // Label element
  const labelEl = document.createElement("span");
  labelEl.id = labelId;
  labelEl.className = "combobox-label-text";
  labelEl.textContent = label;

  // Trigger button
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = triggerId;
  trigger.className = "combobox-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", listboxId);
  trigger.setAttribute("aria-labelledby", `${labelId} ${valueId}`);
  trigger.setAttribute("tabindex", "0");

  // Value display element
  const valueEl = document.createElement("span");
  valueEl.id = valueId;
  valueEl.className = "combobox-value";
  const currentOption = options.find(o => o.value === currentValue);
  valueEl.textContent = currentOption ? currentOption.label : currentValue;

  trigger.appendChild(labelEl);
  trigger.appendChild(valueEl);

  // Listbox
  const listbox = document.createElement("div");
  listbox.id = listboxId;
  listbox.className = "combobox-listbox";
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-labelledby", labelId);
  listbox.hidden = true;

  options.forEach((opt, index) => {
    const optionEl = document.createElement("div");
    optionEl.id = `combobox-option-${id}-${index}`;
    optionEl.className = "combobox-option";
    optionEl.setAttribute("role", "option");
    optionEl.setAttribute("aria-selected", (opt.value === currentValue).toString());
    optionEl.setAttribute("data-value", opt.value);
    optionEl.textContent = opt.label;
    optionEl.addEventListener("click", () => {
      selectOption(trigger, listbox, optionEl, opt.value, onChange);
    });
    listbox.appendChild(optionEl);
  });

  // Trigger handlers
  let isOpen = false;

  function openListbox() {
    if (isOpen) return;
    isOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    listbox.hidden = false;
    // Set aria-activedescendant to currently selected option
    const selected = listbox.querySelector('[aria-selected="true"]');
    if (selected) trigger.setAttribute("aria-activedescendant", selected.id);
    // Position listbox below trigger
    requestAnimationFrame(() => {
      listbox.classList.add("combobox-listbox--open");
    });
    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeydown);
  }

  function closeListbox() {
    if (!isOpen) return;
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    listbox.classList.remove("combobox-listbox--open");
    const handleTransitionEnd = () => {
      listbox.hidden = true;
      listbox.removeEventListener("transitionend", handleTransitionEnd);
    };
    listbox.addEventListener("transitionend", handleTransitionEnd);
    document.removeEventListener("click", handleClickOutside);
    document.removeEventListener("keydown", handleKeydown);
  }

  function handleClickOutside(e) {
    if (!wrapper.contains(e.target)) {
      closeListbox();
    }
  }

  function handleKeydown(e) {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        openListbox();
      }
      return;
    }

    const options = listbox.querySelectorAll(".combobox-option");
    const currentSelected = listbox.querySelector('[aria-selected="true"]');
    let currentIndex = Array.from(options).indexOf(currentSelected);

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        trigger.removeAttribute("aria-activedescendant");
        closeListbox();
        trigger.focus();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        const activeId = trigger.getAttribute("aria-activedescendant");
        const activeOption = activeId ? document.getElementById(activeId) : currentSelected;
        if (activeOption) {
          selectOption(trigger, listbox, activeOption, activeOption.dataset.value, onChange);
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        currentIndex = Math.min(currentIndex + 1, options.length - 1);
        updateActiveDescendant(trigger, options, currentIndex);
        break;
      case "ArrowUp":
        e.preventDefault();
        currentIndex = Math.max(currentIndex - 1, 0);
        updateActiveDescendant(trigger, options, currentIndex);
        break;
      case "Home":
        e.preventDefault();
        updateActiveDescendant(trigger, options, 0);
        break;
      case "End":
        e.preventDefault();
        updateActiveDescendant(trigger, options, options.length - 1);
        break;
      case "Tab":
        closeListbox();
        break;
    }
  }

  trigger.addEventListener("click", e => {
    if (isOpen) {
      closeListbox();
    } else {
      openListbox();
    }
  });

  trigger.addEventListener("keydown", handleKeydown);

  wrapper.appendChild(trigger);
  wrapper.appendChild(listbox);

  return wrapper;
}

function selectOption(trigger, listbox, optionEl, value, onChange) {
  // Update aria-selected
  listbox.querySelectorAll(".combobox-option").forEach(opt => {
    opt.setAttribute("aria-selected", "false");
  });
  optionEl.setAttribute("aria-selected", "true");

  // Update trigger value display
  const valueEl = trigger.querySelector(".combobox-value");
  if (valueEl) {
    valueEl.textContent = optionEl.textContent;
  }

  // Call onChange
  onChange(value);

  // Close and return focus
  trigger.setAttribute("aria-expanded", "false");
  trigger.removeAttribute("aria-activedescendant");
  listbox.classList.remove("combobox-listbox--open");
  const handleTransitionEnd = () => {
    listbox.hidden = true;
    listbox.removeEventListener("transitionend", handleTransitionEnd);
  };
  listbox.addEventListener("transitionend", handleTransitionEnd);
  document.removeEventListener("click", handleClickOutside);
  document.removeEventListener("keydown", handleKeydown);
  trigger.focus();
}

// Need to reference these for the close handler
let handleClickOutside = () => {};
let handleKeydown = () => {};

function updateComboboxValue(id, value, dict) {
  const trigger = document.getElementById(`combobox-trigger-${id}`);
  if (!trigger) return;
  const valueEl = trigger.querySelector(".combobox-value");
  const listbox = document.getElementById(`combobox-listbox-${id}`);
  if (!valueEl || !listbox) return;

  const options = listbox.querySelectorAll(".combobox-option");
  options.forEach(opt => {
    const isSelected = opt.dataset.value === value;
    opt.setAttribute("aria-selected", isSelected.toString());
    if (isSelected) {
      valueEl.textContent = opt.textContent;
    }
  });
}

function updateActiveDescendant(trigger, options, index) {
  const optionEl = options[index];
  if (!optionEl) return;
  trigger.setAttribute("aria-activedescendant", optionEl.id);
  // Scroll into view if needed
  optionEl.scrollIntoView({ block: "nearest" });
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