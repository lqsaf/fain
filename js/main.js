import { applyUserPreferences, initAsciiSineWaves, initTopPanel } from "./ui.js";
import { getLocalCacheState, fetchAndSyncNews, t } from "./data.js";
import { renderFeed, showEmptyFeedStatus, updateFooterTimestamp } from "./feed.js";

document.addEventListener("DOMContentLoaded", () => {
  applyUserPreferences();
  applyStaticTranslations();
  initTopPanel();
  initAsciiSineWaves();
  initNewsFeed();
});

function applyStaticTranslations() {
  const dict = t();
  document.title = dict.pageTitleFeed;

  const settingsLink = document.getElementById("nav-settings-link");
  if (settingsLink) {
    settingsLink.setAttribute("aria-label", dict.settingsAria);
    settingsLink.setAttribute("title", dict.settingsAria);
  }

  const initialStatus = document.getElementById("initial-status");
  if (initialStatus) {
    initialStatus.textContent = dict.syncing;
  }

  const updatedLabel = document.getElementById("updated-label");
  if (updatedLabel) {
    updatedLabel.textContent = dict.updated;
  }

  const supportLink = document.getElementById("support-link");
  if (supportLink) {
    supportLink.textContent = dict.support;
  }
}

async function initNewsFeed() {
  const now = Date.now();
  const { cachedItems, readMap, lastUpdated } = getLocalCacheState(now);

  // Мгновенно показываем закэшированные непрочитанные новости
  if (cachedItems.length > 0) {
    renderFeed(cachedItems, readMap);
    updateFooterTimestamp(lastUpdated);
  }

  // Запрашиваем свежие новости у воркера и объединяем с локальным кэшем
  try {
    const { updatedItems, lastUpdated: newTimestamp } = await fetchAndSyncNews(
      cachedItems,
      readMap,
      now
    );
    renderFeed(updatedItems, readMap);
    updateFooterTimestamp(newTimestamp);
    return;
  } catch (err) {
    console.warn("Воркер недоступен, используем локальный кэш:", err);
  }

  if (cachedItems.length === 0) {
    showEmptyFeedStatus();
  }
}