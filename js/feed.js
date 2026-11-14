import { markNewsIdAsRead } from "./data.js";

const TIME_BUCKETS = [
  { key: "today", label: "сегодня" },
  { key: "yesterday", label: "вчера" },
  { key: "week", label: "на этой неделе" },
  { key: "month", label: "в этом месяце" }
];

export function renderFeed(allItems, readMap) {
  const feedEl = document.getElementById("news-feed");
  if (!feedEl) return;

  const unreadItems = allItems.filter(item => !readMap[item.id]);

  if (unreadItems.length === 0) {
    feedEl.innerHTML = `<div class="status-line">все новости прочитаны</div>`;
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

  for (const bucketInfo of TIME_BUCKETS) {
    const itemsInBucket = grouped[bucketInfo.key];
    if (!itemsInBucket || itemsInBucket.length === 0) continue;

    const groupSection = document.createElement("div");
    groupSection.className = "time-group";
    groupSection.dataset.bucket = bucketInfo.key;

    const divider = document.createElement("div");
    divider.className = "time-divider";
    divider.textContent = bucketInfo.label;
    groupSection.appendChild(divider);

    for (const item of itemsInBucket) {
      groupSection.appendChild(createNewsCard(item));
    }

    feedEl.appendChild(groupSection);
  }
}

export function showEmptyFeedStatus() {
  const feedEl = document.getElementById("news-feed");
  if (feedEl) {
    feedEl.innerHTML = `<div class="status-line">нет свежих новостей</div>`;
  }
}

export function updateFooterTimestamp(isoDate) {
  const el = document.getElementById("updated-date");
  if (!el || !isoDate) return;

  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return;

  el.textContent = d.toLocaleString("ru-RU", {
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

function createNewsCard(item) {
  const article = document.createElement("article");
  article.className = "news-item";
  article.dataset.id = item.id;

  // 1. Тег выше заголовка без рамки (если есть)
  if (item.tag && item.tag.trim() !== "") {
    const tagEl = document.createElement("span");
    tagEl.className = "news-tag";
    tagEl.textContent = item.tag.trim();
    article.appendChild(tagEl);
  }

  // 2. Заголовок-гиперссылка, раскрывающая ИИ-анализ
  const titleLink = document.createElement("a");
  titleLink.href = "#ai-analysis";
  titleLink.className = "news-title";
  titleLink.textContent = item.title;

  const analysisWrap = document.createElement("div");
  analysisWrap.className = "news-analysis-wrap";

  const analysisBox = document.createElement("div");
  analysisBox.className = "news-analysis";

  const analysisLabel = document.createElement("span");
  analysisLabel.className = "analysis-label";
  analysisLabel.textContent = "// ии-анализ";

  const analysisText = document.createElement("p");
  analysisText.textContent = item.analysis || "Анализ недоступен.";

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
  descEl.title = "Нажмите, чтобы отметить прочитанным и скрыть";
  descEl.textContent = item.summary;

  descEl.addEventListener("click", () => {
    markAsReadAndRemove(item.id, article);
  });

  // 4. Ссылка «источник» справа снизу
  const metaRow = document.createElement("div");
  metaRow.className = "news-meta";

  const sourceLink = document.createElement("a");
  sourceLink.className = "news-source";
  sourceLink.href = item.url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.textContent = "источник";

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
      feedEl.innerHTML = `<div class="status-line">все новости прочитаны</div>`;
    }
  }, 340);
}