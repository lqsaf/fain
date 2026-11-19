import { markNewsIdAsRead, t } from "./data.js";

const BUCKET_KEYS = ["today", "yesterday", "week", "month"];

export function renderFeed(allItems, readMap) {
  const feedEl = document.getElementById("news-feed");
  if (!feedEl) return;

  const dict = t();

  // Сохраняем ID карточек, у которых уже был открыт блок ИИ-анализа
  const openAnalysisIds = new Set();
  feedEl.querySelectorAll(".news-item").forEach(card => {
    const wrap = card.querySelector(".news-analysis-wrap");
    if (wrap && wrap.classList.contains("open") && card.dataset.id) {
      openAnalysisIds.add(card.dataset.id);
    }
  });

  const unreadItems = allItems.filter(item => !readMap[item.id]);

  if (unreadItems.length === 0) {
    feedEl.innerHTML = `<div class="status-line">${dict.allRead}</div>`;
    return;
  }

  const grouped = {
    today: [],
    yesterday: [],
    week: [],
    month: []
  };

  for (const item of unreadItems) {
    const bucket = getTimeBucketKey(item.publishedAt);
    grouped[bucket].push(item);
  }

  feedEl.innerHTML = "";

  for (const key of BUCKET_KEYS) {
    const itemsInBucket = grouped[key];
    if (!itemsInBucket || itemsInBucket.length === 0) continue;

    const groupSection = document.createElement("div");
    groupSection.className = "time-group";
    groupSection.dataset.bucket = key;

    const divider = document.createElement("div");
    divider.className = "time-divider";
    divider.textContent = dict.buckets[key] || dict.buckets.week || key;
    groupSection.appendChild(divider);

    for (const item of itemsInBucket) {
      const isOpen = openAnalysisIds.has(item.id);
      groupSection.appendChild(createNewsCard(item, dict, isOpen));
    }

    feedEl.appendChild(groupSection);
  }
}

export function showEmptyFeedStatus() {
  const feedEl = document.getElementById("news-feed");
  if (feedEl) {
    const dict = t();
    feedEl.innerHTML = `<div class="status-line">${dict.emptyFeed}</div>`;
  }
}

export function updateFooterTimestamp(isoDate) {
  const el = document.getElementById("updated-date");
  if (!el || !isoDate) return;

  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return;

  const dict = t();
  el.textContent = getRelativeTime(isoDate, dict);
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function getRelativeTime(isoDate, dict) {
  const d = new Date(isoDate);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return dict.time.justNow;

  if (diffMin < 60) {
    if (dict.locale === "ru-RU") return `${diffMin} ${plural(diffMin, dict.time.minutes)}`;
    return `${diffMin} ${dict.time.minutes}`;
  }

  if (diffHour < 24) {
    if (dict.locale === "ru-RU") return `${diffHour} ${plural(diffHour, dict.time.hours)}`;
    return `${diffHour} ${dict.time.hours}`;
  }

  if (diffDay <= 30) {
    if (dict.locale === "ru-RU") return `${diffDay} ${plural(diffDay, dict.time.days)}`;
    return `${diffDay} ${dict.time.days}`;
  }

  return d.toLocaleString(dict.locale || "ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getTimeBucketKey(publishedAtIso) {
  const itemDate = new Date(publishedAtIso);
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const ts = itemDate.getTime();

  if (ts >= startOfToday) return "today";
  if (ts >= startOfYesterday) return "yesterday";
  if (ts >= startOfWeek) return "week";
  return "month";
}

function createNewsCard(item, dict, isAnalysisOpen = false) {
  const article = document.createElement("article");
  article.className = "news-item";
  article.dataset.id = item.id;

  // 1. Тег выше заголовка (с переводом по словарю)
  if (item.tag && item.tag.trim() !== "") {
    const rawTag = item.tag.trim().toLowerCase();
    const localizedTag = dict.tags?.[rawTag] || item.tag.trim();
    const tagEl = document.createElement("span");
    tagEl.className = "news-tag";
    tagEl.textContent = localizedTag;
    article.appendChild(tagEl);
  }

  // 2. Заголовок-гиперссылка, раскрывающая ИИ-анализ
  const titleLink = document.createElement("a");
  titleLink.href = "#ai-analysis";
  titleLink.className = "news-title" + (isAnalysisOpen ? " active" : "");
  titleLink.textContent = item.title;

  const analysisWrap = document.createElement("div");
  analysisWrap.className = "news-analysis-wrap" + (isAnalysisOpen ? " open" : "");

  const analysisBox = document.createElement("div");
  analysisBox.className = "news-analysis";

  const analysisLabel = document.createElement("span");
  analysisLabel.className = "analysis-label";
  analysisLabel.textContent = dict.aiAnalysis;

  const analysisText = document.createElement("p");
  analysisText.textContent = item.analysis || dict.analysisUnavailable;

  analysisBox.appendChild(analysisLabel);
  analysisBox.appendChild(analysisText);
  analysisWrap.appendChild(analysisBox);

  titleLink.addEventListener("click", e => {
    e.preventDefault();
    const isOpen = analysisWrap.classList.toggle("open");
    titleLink.classList.toggle("active", isOpen);
  });

  // 3. Описание (при клике — новость считается прочитанной и удаляется)
  const descEl = document.createElement("div");
  descEl.className = "news-description";
  descEl.textContent = item.summary;

  // 4. Ссылка «источник» справа снизу
  const metaRow = document.createElement("div");
  metaRow.className = "news-meta";

  const markReadBtn = document.createElement("button");
  markReadBtn.className = "mark-as-read-btn";
  markReadBtn.textContent = dict.markRead;
  markReadBtn.setAttribute("aria-label", dict.clickToMarkRead);
  markReadBtn.addEventListener("click", () => {
    markAsReadAndRemove(item.id, article);
  });

  const sourceLink = document.createElement("a");
  sourceLink.className = "news-source";
  sourceLink.href = item.url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.textContent = dict.source;

  metaRow.appendChild(markReadBtn);
  metaRow.appendChild(sourceLink);

  article.appendChild(titleLink);
  article.appendChild(analysisWrap);
  article.appendChild(descEl);
  article.appendChild(metaRow);

  return article;
}

function markAsReadAndRemove(id, articleEl) {
  if (articleEl.classList.contains("terminal-collapse")) return;

  markNewsIdAsRead(id);
  articleEl.classList.add("terminal-collapse");

  setTimeout(() => {
    const parentGroup = articleEl.closest(".time-group");
    articleEl.remove();

    if (parentGroup && parentGroup.querySelectorAll(".news-item").length === 0) {
      parentGroup.remove();
    }

    const feedEl = document.getElementById("news-feed");
    if (feedEl && feedEl.querySelectorAll(".news-item").length === 0) {
      const dict = t();
      feedEl.innerHTML = `<div class="status-line">${dict.allRead}</div>`;
    }
  }, 340);
}