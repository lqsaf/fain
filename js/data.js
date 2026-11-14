const WORKER_URL = "https://fain-worker.weraktesau.workers.dev/";

export const STORAGE_KEYS = {
  ITEMS: "fain_cached_items_v2",
  READ_IDS: "fain_read_ids_v1",
  LAST_UPDATED: "fain_last_updated_v1"
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
  const response = await fetch(WORKER_URL, { method: "GET" });
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
  localStorage.setItem(STORAGE_KEYS.LAST_UPDATED, lastUpdated);

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