import { initAsciiSineWaves, initTopPanel } from "./ui.js";
import { getLocalCacheState, fetchAndSyncNews } from "./data.js";
import { renderFeed, showEmptyFeedStatus, updateFooterTimestamp } from "./feed.js";

document.addEventListener("DOMContentLoaded", () => {
  initTopPanel();
  initAsciiSineWaves();
  initNewsFeed();
});

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