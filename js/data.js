const WORKER_URL = "https://fain-worker.weraktesau.workers.dev/";

export const STORAGE_KEYS = {
  ITEMS: "fain_cached_items_v2",
  READ_IDS: "fain_read_ids_v1",
  LAST_UPDATED: "fain_last_updated_v1",
  LANG: "fain_lang_v1",
  THEME: "fain_theme_v1",
  ASCII: "fain_ascii_v1",
  CUSTOM_CSS: "fain_custom_css_v1"
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const I18N = {
  ru: {
    locale: "ru-RU",
    pageTitleFeed: "fain — free ai news",
    pageTitleSettings: "настройки — fain",
    settingsAria: "Настройки",
    backToFeed: "← назад",
    syncing: "синхронизация потока...",
    allRead: "все новости прочитаны",
    emptyFeed: "нет свежих новостей",
    updated: "обновлено:",
    aiAnalysis: "// ии-анализ",
    analysisUnavailable: "Анализ недоступен.",
    clickToMarkRead: "Нажмите, чтобы отметить прочитанным и скрыть",
    source: "источник",
    buckets: {
      today: "сегодня",
      yesterday: "вчера",
      week: "на этой неделе",
      month: "в этом месяце"
    },
    tags: {
      "#релиз": "#релиз",
      "#анонс": "#анонс",
      "#исследование": "#исследование",
      "release": "#релиз",
      "announce": "#анонс",
      "research": "#исследование"
    },
    settings: {
      langLabel: "// язык",
      themeLabel: "// тема оформления",
      themes: {
        dark: "монохром",
        light: "газетная",
        amber: "янтарная",
        phosphor: "фосфор"
      },
      asciiLabel: "// боковые ascii-волны (пк)",
      asciiOn: "вкл",
      asciiOff: "выкл",
      customCssLabel: "// пользовательский css (в кэше)",
      customCssHint: "Стили применяются поверх текущей темы и сохраняются локально в браузере.",
      customCssPlaceholder: ":root {\n  --bg: #050505;\n  --text-main: #e0e0e0;\n}",
      applyCss: "применить",
      uploadCss: "загрузить .css",
      resetCss: "сбросить",
      savedToast: "сохранено"
    }
  },
  en: {
    locale: "en-US",
    pageTitleFeed: "fain — free ai news",
    pageTitleSettings: "settings — fain",
    settingsAria: "Settings",
    backToFeed: "← back",
    syncing: "synchronizing feed...",
    allRead: "all news read",
    emptyFeed: "no recent news",
    updated: "updated:",
    aiAnalysis: "// ai-analysis",
    analysisUnavailable: "Analysis unavailable.",
    clickToMarkRead: "Click to mark as read and dismiss",
    source: "source",
    buckets: {
      today: "today",
      yesterday: "yesterday",
      week: "this week",
      month: "this month"
    },
    tags: {
      "#релиз": "#release",
      "#анонс": "#announce",
      "#исследование": "#research",
      "release": "#release",
      "announce": "#announce",
      "research": "#research"
    },
    settings: {
      langLabel: "// language",
      themeLabel: "// color theme",
      themes: {
        dark: "monochrome",
        light: "e-ink",
        amber: "amber",
        phosphor: "phosphor"
      },
      asciiLabel: "// side ascii waves (desktop)",
      asciiOn: "on",
      asciiOff: "off",
      customCssLabel: "// custom css (cached)",
      customCssHint: "Styles override the active theme and persist in local storage.",
      customCssPlaceholder: ":root {\n  --bg: #050505;\n  --text-main: #e0e0e0;\n}",
      applyCss: "apply",
      uploadCss: "upload .css",
      resetCss: "reset",
      savedToast: "saved"
    }
  },
  zh: {
    locale: "zh-CN",
    pageTitleFeed: "fain — 免费 AI 资讯",
    pageTitleSettings: "设置 — fain",
    settingsAria: "设置",
    backToFeed: "← 返回",
    syncing: "正在同步资讯流...",
    allRead: "所有资讯已读",
    emptyFeed: "暂无最新资讯",
    updated: "更新于:",
    aiAnalysis: "// ai 深度分析",
    analysisUnavailable: "暂无分析。",
    clickToMarkRead: "点击标记为已读并隐藏",
    source: "来源",
    buckets: {
      today: "今天",
      yesterday: "昨天",
      week: "本周",
      month: "本月"
    },
    tags: {
      "#релиз": "#发布",
      "#анонс": "#预告",
      "#исследование": "#研究",
      "release": "#发布",
      "announce": "#预告",
      "research": "#研究"
    },
    settings: {
      langLabel: "// 语言 / language",
      themeLabel: "// 界面主题",
      themes: {
        dark: "黑白终端",
        light: "电子墨水",
        amber: "复古琥珀",
        phosphor: "荧光绿"
      },
      asciiLabel: "// 侧边 ascii 波形 (桌面端)",
      asciiOn: "开启",
      asciiOff: "关闭",
      customCssLabel: "// 自定义 css (本地缓存)",
      customCssHint: "自定义样式将覆盖当前主题并保存在本地浏览器缓存中。",
      customCssPlaceholder: ":root {\n  --bg: #050505;\n  --text-main: #e0e0e0;\n}",
      applyCss: "应用",
      uploadCss: "上传 .css",
      resetCss: "重置",
      savedToast: "已保存"
    }
  }
};

export function getUserLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.LANG);
    if (saved && I18N[saved]) return saved;
  } catch {}

  const nav = (navigator.language || navigator.userLanguage || "ru").toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("en")) return "en";
  if (nav.startsWith("ru") || nav.startsWith("uk") || nav.startsWith("be") || nav.startsWith("kk")) {
    return "ru";
  }
  return "en";
}

export function setUserLang(lang) {
  if (!I18N[lang]) return;
  try {
    localStorage.setItem(STORAGE_KEYS.LANG, lang);
  } catch {}
}

export function t() {
  return I18N[getUserLang()] || I18N.ru;
}

export function getUserPreferences() {
  let theme = "dark";
  let ascii = "on";
  let customCss = "";

  try {
    theme = localStorage.getItem(STORAGE_KEYS.THEME) || "dark";
    ascii = localStorage.getItem(STORAGE_KEYS.ASCII) || "on";
    customCss = localStorage.getItem(STORAGE_KEYS.CUSTOM_CSS) || "";
  } catch {}

  return {
    lang: getUserLang(),
    theme,
    ascii,
    customCss
  };
}

export function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Ошибка сохранения в localStorage:", e);
  }
}

export function getLocalCacheState(now = Date.now()) {
  let cachedItems = loadJson(STORAGE_KEYS.ITEMS, []);
  let readMap = loadJson(STORAGE_KEYS.READ_IDS, {});
  const lastUpdated = localStorage.getItem(STORAGE_KEYS.LAST_UPDATED) || null;

  cachedItems = filterRecentItems(cachedItems, now);
  readMap = cleanOldReadIds(readMap, now);

  return { cachedItems, readMap, lastUpdated };
}

export async function fetchAndSyncNews(cachedItems, readMap, now = Date.now()) {
  const lang = getUserLang();
  const url = `${WORKER_URL}?lang=${encodeURIComponent(lang)}`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const remoteData = await response.json();
  if (!remoteData || !Array.isArray(remoteData.items)) {
    throw new Error("Некорректный формат ответа воркера");
  }

  const updatedItems = mergeNewsItems(cachedItems, remoteData.items, now);
  const lastUpdated = remoteData.lastUpdated || new Date().toISOString();

  saveJson(STORAGE_KEYS.ITEMS, updatedItems);
  saveJson(STORAGE_KEYS.READ_IDS, readMap);
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_UPDATED, lastUpdated);
  } catch {}

  return { updatedItems, lastUpdated };
}

export function markNewsIdAsRead(id) {
  const readMap = loadJson(STORAGE_KEYS.READ_IDS, {});
  readMap[id] = Date.now();
  saveJson(STORAGE_KEYS.READ_IDS, readMap);
}

function mergeNewsItems(localItems, remoteItems, now) {
  const byId = new Map();

  for (const item of localItems) {
    if (item && item.id) byId.set(item.id, item);
  }
  for (const item of remoteItems) {
    if (item && item.id) byId.set(item.id, item);
  }

  const merged = Array.from(byId.values());
  return filterRecentItems(merged, now)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 50);
}

function filterRecentItems(items, now) {
  return items.filter(item => {
    if (!item || !item.publishedAt) return false;
    const timestamp = new Date(item.publishedAt).getTime();
    return !Number.isNaN(timestamp) && (now - timestamp) <= THIRTY_DAYS_MS;
  });
}

function cleanOldReadIds(readMap, now) {
  const cleaned = {};
  for (const [id, readAt] of Object.entries(readMap)) {
    if (now - Number(readAt) <= THIRTY_DAYS_MS) {
      cleaned[id] = readAt;
    }
  }
  return cleaned;
}