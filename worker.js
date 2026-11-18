// Функция парсинга ключей напрямую из секрета GitHub (заменяет глобальный массив GEMINI_KEYS)
function getGeminiKeys(env) {
  if (!env || !env.GEMINI_KEYS) {
    console.warn("Секрет GEMINI_KEYS не задан в окружении");
    return [];
  }
  // Разбиваем строку по запятой и очищаем от кавычек, пробелов и переносов строк
  return env.GEMINI_KEYS.split(',').map(key => key.replace(/[\s"'\n\r]+/g, ''));
}

// Модели по возрастанию вычислительной сложности (от 500 RPD к 20 RPD)
const GEMINI_MODELS = [
  "gemini-3.1-flash-lite", // 15 RPM | 500 RPD
  "gemini-3.5-flash-lite", // 15 RPM | 500 RPD
  "gemini-3.6-flash",      //  5 RPM |  20 RPD
  "gemini-3.8-flash"       //  5 RPM |  20 RPD
];

const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI", url: "https://blog.google/innovation-and-ai/technology/ai/rss/" },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { name: "Anthropic & Claude Radar", url: "https://news.google.com/rss/search?q=Anthropic+OR+%22Claude%22+AI+when:7d&hl=en-US&gl=US&ceid=US:en" },
  { name: "Gemini & Frontier Radar", url: "https://news.google.com/rss/search?q=%22Gemini%22+model+OR+%22DeepSeek%22+OR+%22Qwen%22+OR+%22Mistral%22+when:7d&hl=en-US&gl=US&ceid=US:en" },
  { name: "Microsoft AI Research", url: "https://www.microsoft.com/en-us/research/feed/" },
  { name: "MIT Tech Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/" },
  { name: "Ars Technica AI", url: "https://arstechnica.com/ai/feed/" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "9to5Google", url: "https://9to5google.com/feed/" }
];

const KV_STORE_KEY = "fain_news_store_v1";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 10;

// Строгие JSON-схемы для каждого из 5 шагов конвейера
const STEP_SCHEMAS = {
  step1: {
    type: "OBJECT",
    properties: {
      selectedIds: { type: "ARRAY", items: { type: "INTEGER" } }
    },
    required: ["selectedIds"]
  },
  step2: {
    type: "OBJECT",
    properties: {
      uniqueIds: { type: "ARRAY", items: { type: "INTEGER" } }
    },
    required: ["uniqueIds"]
  },
  step3: {
    type: "OBJECT",
    properties: {
      articles: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "INTEGER" },
            ru: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" } }, required: ["title", "summary"] },
            en: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" } }, required: ["title", "summary"] },
            zh: { type: "OBJECT", properties: { title: { type: "STRING" }, summary: { type: "STRING" } }, required: ["title", "summary"] }
          },
          required: ["id", "ru", "en", "zh"]
        }
      }
    },
    required: ["articles"]
  },
  step4: {
    type: "OBJECT",
    properties: {
      tags: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "INTEGER" },
            tag: { type: "STRING" }
          },
          required: ["id", "tag"]
        }
      }
    },
    required: ["tags"]
  },
  step5: {
    type: "OBJECT",
    properties: {
      analyses: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "INTEGER" },
            ru: { type: "STRING" },
            en: { type: "STRING" },
            zh: { type: "STRING" }
          },
          required: ["id", "ru", "en", "zh"]
        }
      }
    },
    required: ["analyses"]
  }
};

let memoryFallbackStore = { lastUpdated: null, items: [] };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const lang = ["ru", "en", "zh"].includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : "ru";

    if (request.method === "POST" && url.pathname === "/refresh") {
      const auth = request.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ") || !env.REFRESH_TOKEN) return new Response("Unauthorized", { status: 401 });

      const token = auth.split(" ")[1];
      const encoder = new TextEncoder();
      const a = encoder.encode(token);
      const b = encoder.encode(env.REFRESH_TOKEN);

      if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return new Response("Unauthorized", { status: 401 });

      const updatedStore = await runHourlyPipeline(env);
      return new Response(JSON.stringify(updatedStore), { headers: CORS_HEADERS });
    }

    let store = await loadStore(env);

    if (!store.lastUpdated || store.items.length === 0) {
      return new Response(JSON.stringify({ status: "empty", message: "Feed is empty, please trigger /refresh" }), { status: 202, headers: CORS_HEADERS });
    } else {
      const now = Date.now();
      store.items = cleanStoreItems(store.items, now);
    }

    // Фильтруем данные под нужный язык
    const responseStore = {
      lastUpdated: store.lastUpdated,
      items: store.items.slice(0, 50).map(item => ({
        id: item.id,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt,
        tag: item.tag,
        title: item.translations[lang].title,
        summary: item.translations[lang].summary,
        analysis: item.translations[lang].analysis,
        originalTitle: item.originalTitle
      }))
    };

    return new Response(JSON.stringify(responseStore), { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHourlyPipeline(env));
  }
};

// Основной конвейер сбора и обработки новостей
async function runHourlyPipeline(env) {
  const now = Date.now();
  const store = await loadStore(env);

  // 0. Очищаем базу
  store.items = cleanStoreItems(store.items || [], now);

  const existingUrls = new Set(store.items.map(i => normalizeUrl(i.url)));
  const rawCandidates = await fetchAllRssFeeds(existingUrls, store.items, now);

  if (rawCandidates.length === 0) {
    store.lastUpdated = new Date(now).toISOString();
    await saveStore(env, store);
    return store;
  }

  const pool = rawCandidates.slice(0, 45);

  // КЛЮЧ 1: Отбор
  const step1Prompt = `Ты — главный фильтр ИИ-новостей проекта fain.
Из списка кандидатов выбери только прорывные и значимые новости строго про ИИ.
СТРОГИЕ ПРАВИЛА:
1. Только ИИ (модели, функции, исследования).
2. ПРАВИЛО ОДНОГО СЮЖЕТА: если сюжет один — выбери ОДНУ самую полную новость.
3. Максимум ${MAX_BATCH_SIZE} новостей.
Верни JSON: {"selectedIds": [числа id]}

Кандидаты:
${JSON.stringify(pool.map((item, idx) => ({
  id: idx,
  source: item.source,
  title: item.rawTitle,
  snippet: item.rawSnippet
})))}`;

  const step1Res = await callGeminiWithFallback(0, step1Prompt, STEP_SCHEMAS.step1, env);
  if (!Array.isArray(step1Res?.selectedIds) || step1Res.selectedIds.length === 0) {
    store.lastUpdated = new Date(now).toISOString();
    await saveStore(env, store);
    return store;
  }

  const seenStep1Ids = new Set();
  let candidates = [];
  for (const rawId of step1Res.selectedIds) {
    const id = Number(rawId);
    if (!Number.isNaN(id) && pool[id] && !seenStep1Ids.has(id)) {
      seenStep1Ids.add(id);
      candidates.push(pool[id]);
    }
  }
  candidates = candidates.slice(0, MAX_BATCH_SIZE);

  if (candidates.length === 0) {
    store.lastUpdated = new Date(now).toISOString();
    await saveStore(env, store);
    return store;
  }

  // КЛЮЧ 2: Дедупликация
  const publishedHistory = store.items.slice(0, 60).map(item => ({
    title: item.translations.ru.title,
    originalTitle: item.originalTitle,
    summary: item.translations.ru.summary
  }));

  const step2Prompt = `Ты — строгий тематический дедупликатор.
1. Сравни кандидатов с опубликованными. Отбрось дубли.
2. Сравни кандидатов между собой.
Верни JSON: {"uniqueIds": [числа id]}

Уже опубликовано:
${JSON.stringify(publishedHistory)}

Кандидаты:
${JSON.stringify(candidates.map((c, idx) => ({
  id: idx,
  title: c.rawTitle,
  snippet: c.rawSnippet
})))}`;

  const step2Res = await callGeminiWithFallback(1, step2Prompt, STEP_SCHEMAS.step2, env);
  if (!Array.isArray(step2Res?.uniqueIds)) return store;

  const seenStep2Ids = new Set();
  const uniqueCandidates = [];
  for (const rawId of step2Res.uniqueIds) {
    const id = Number(rawId);
    if (!Number.isNaN(id) && candidates[id] && !seenStep2Ids.has(id)) {
      seenStep2Ids.add(id);
      uniqueCandidates.push(candidates[id]);
    }
  }
  candidates = uniqueCandidates;

  if (candidates.length === 0) {
    store.lastUpdated = new Date(now).toISOString();
    await saveStore(env, store);
    return store;
  }

  // КЛЮЧ 3: Редактор — переводы на RU, EN, ZH
  const step3Prompt = `Ты — техно-редактор.
Для каждой новости создай заголовок и summary на трёх языках: RU, EN, ZH.
Соблюдай профессиональный стиль.
Верни JSON: {"articles": [{"id": число, "ru": {...}, "en": {...}, "zh": {...}}]}

Новости:
${JSON.stringify(candidates.map((c, idx) => ({
  id: idx,
  source: c.source,
  title: c.rawTitle,
  snippet: c.rawSnippet
})))}`;

  const step3Res = await callGeminiWithFallback(2, step3Prompt, STEP_SCHEMAS.step3, env);
  if (!Array.isArray(step3Res?.articles) || step3Res.articles.length === 0) return store;

  const articlesMap = new Map();
  for (const art of step3Res.articles) {
    articlesMap.set(Number(art.id), art);
  }

  const translatedCandidates = [];
  for (let i = 0; i < candidates.length; i++) {
    const art = articlesMap.get(i);
    if (art) {
      translatedCandidates.push({ ...candidates[i], translations: { ru: art.ru, en: art.en, zh: art.zh } });
    }
  }

  // КЛЮЧ 4: Тегировщик
  const step4Prompt = `Присвой тег: "#релиз", "#анонс", "#исследование" или "".
Верни JSON: {"tags": [{"id": число, "tag": "..."}]}

Новости:
${JSON.stringify(translatedCandidates.map((c, idx) => ({
  id: idx,
  title: c.translations.en.title, // используем английский для понимания
  summary: c.translations.en.summary
})))}`;

  const step4Res = await callGeminiWithFallback(3, step4Prompt, STEP_SCHEMAS.step4, env);
  const tagsMap = new Map();
  const validTags = new Set(["#релиз", "#анонс", "#исследование", ""]);
  if (Array.isArray(step4Res?.tags)) {
    for (const t of step4Res.tags) {
      const cleanTag = (t.tag || "").trim().toLowerCase();
      tagsMap.set(Number(t.id), validTags.has(cleanTag) ? cleanTag : "");
    }
  }

  // КЛЮЧ 5: Аналитик — на 3 языках
  const step5Prompt = `Ты — ведущий ИИ-аналитик.
Для каждой новости напиши аналитический разбор на RU, EN, ZH.
Верни JSON: {"analyses": [{"id": число, "ru": "...", "en": "...", "zh": "..."}]}

Новости:
${JSON.stringify(translatedCandidates.map((c, idx) => ({
  id: idx,
  title: c.translations.en.title,
  summary: c.translations.en.summary
})))}`;

  const step5Res = await callGeminiWithFallback(4, step5Prompt, STEP_SCHEMAS.step5, env);
  const analysisMap = new Map();
  if (Array.isArray(step5Res?.analyses)) {
    for (const a of step5Res.analyses) {
      analysisMap.set(Number(a.id), { ru: a.ru, en: a.en, zh: a.zh });
    }
  }

  // Собираем
  const newItems = [];
  for (let idx = 0; idx < translatedCandidates.length; idx++) {
    const c = translatedCandidates[idx];
    const analysis = analysisMap.get(idx);
    if (!analysis) continue;

    newItems.push({
      id: generateId(c.url),
      translations: {
        ru: { title: c.translations.ru.title, summary: c.translations.ru.summary, analysis: analysis.ru },
        en: { title: c.translations.en.title, summary: c.translations.en.summary, analysis: analysis.en },
        zh: { title: c.translations.zh.title, summary: c.translations.zh.summary, analysis: analysis.zh }
      },
      originalTitle: c.rawTitle,
      tag: tagsMap.get(idx) ?? "",
      url: c.url,
      source: c.source,
      publishedAt: c.publishedAt
    });
  }

  store.items = cleanStoreItems([...newItems, ...store.items], now).slice(0, 200);
  store.lastUpdated = new Date(now).toISOString();
  await saveStore(env, store);
  return store;
}

// Вызов Gemini
async function callGeminiWithFallback(keyIndex, promptText, responseSchema, env) {
  const keys = getGeminiKeys(env);
  const orderedKeys = Array.from(new Set([keys[keyIndex], keys[5], ...keys].filter(Boolean)));
  const deadModels = new Set();

  for (const apiKey of orderedKeys) {
    for (const modelName of GEMINI_MODELS) {
      if (deadModels.has(modelName)) continue;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: "application/json", responseSchema }
          }),
          signal: controller.signal
        });
        if (response.status === 404) { deadModels.add(modelName); continue; }
        if (!response.ok) continue;
        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) continue;
        const cleanedJson = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        return JSON.parse(cleanedJson);
      } catch (err) {
        if (err.name === "AbortError") {
          console.warn("Gemini API timeout");
        } else {
          console.warn(err.message);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  return null;
}

// RSS
async function fetchAllRssFeeds(existingUrls, existingItems, now) {
  const results = await Promise.allSettled(
    RSS_SOURCES.map(async source => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(source.url, {
          headers: { "User-Agent": "fain-news-bot/1.0 (+https://github.com/lqsaf/fain)" },
          signal: controller.signal
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseFeedXml(xml, source.name, now);
      } finally { clearTimeout(timeout); }
    })
  );

  const seenUrlsInBatch = new Set();
  const allItems = [];

  for (const res of results) {
    if (res.status !== "fulfilled" || !Array.isArray(res.value)) continue;
    for (const item of res.value) {
      const normUrl = normalizeUrl(item.url);
      if (!normUrl || existingUrls.has(normUrl) || seenUrlsInBatch.has(normUrl)) continue;
      if (normUrl.includes("/business/customer-stories/")) continue;
      const isDupInStore = existingItems.some(ex => isSimilarTitle(item.rawTitle, ex.originalTitle));
      const isDupInBatch = allItems.some(b => isSimilarTitle(item.rawTitle, b.rawTitle));
      if (isDupInStore || isDupInBatch) continue;
      seenUrlsInBatch.add(normUrl);
      allItems.push(item);
    }
  }
  return allItems.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

function parseFeedXml(xml, sourceName, now) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const rawTitle = stripPublisherSuffix(cleanText(extractTag(block, "title")));
    const link = extractLink(block);
    const dateStr = extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated") || extractTag(block, "dc:date");
    const rawDesc = extractTag(block, "description") || extractTag(block, "summary") || extractTag(block, "content:encoded") || extractTag(block, "content");
    if (!rawTitle || !link) continue;
    let pubTime = dateStr ? Date.parse(dateStr.trim()) : now;
    if (Number.isNaN(pubTime) || pubTime > now) pubTime = now;
    if (now - pubTime > THIRTY_DAYS_MS) continue;
    items.push({
      source: sourceName,
      url: link.trim(),
      rawTitle,
      rawSnippet: stripPublisherSuffix(cleanText(rawDesc)).slice(0, 450),
      publishedAt: new Date(pubTime).toISOString()
    });
  }
  return items;
}

function isValidItem(item) {
  if (!item || !item.id || !item.publishedAt || !item.translations) return false;
  for (const lang of ["ru", "en", "zh"]) {
    const t = item.translations[lang];
    if (!t || !t.title || !t.summary) return false;
  }
  return true;
}

function cleanStoreItems(items, now) {
  const filtered = items
    .filter(item => {
      if (!isValidItem(item)) return false;
      const age = now - new Date(item.publishedAt).getTime();
      return !Number.isNaN(age) && age >= 0 && age <= THIRTY_DAYS_MS;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const result = [];
  const dailyCounts = {};

  for (const item of filtered) {
    // Deduplication
    if (result.some(prev => isSimilarTitle(item.originalTitle, prev.originalTitle))) continue;

    // Daily limit (UTC)
    const dateStr = item.publishedAt.split('T')[0];
    dailyCounts[dateStr] = (dailyCounts[dateStr] || 0) + 1;
    if (dailyCounts[dateStr] > 5) continue;

    result.push(item);
  }

  return result;
}

function stripPublisherSuffix(text) {
  if (!text) return "";
  return text.replace(/\s+[-–—]\s+[A-Za-z0-9.&'\s]{2,35}$/, "").trim();
}

function tokenizeTitle(str) {
  if (!str) return [];
  const stopWords = new Set(["the", "and", "for", "with", "from", "that", "this", "its", "new", "now", "how", "why", "what", "launches", "announces", "introduces", "releases", "says", "after", "over", "into", "more", "about", "can", "will", "just"]);
  return stripPublisherSuffix(str).toLowerCase().replace(/[^a-z0-9\s]/gi, " ").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
}

function isSimilarTitle(titleA, titleB) {
  const tokensA = tokenizeTitle(titleA);
  const tokensB = tokenizeTitle(titleB);
  if (tokensA.length < 3 || tokensB.length < 3) return false;
  const setB = new Set(tokensB);
  let matches = 0;
  for (const t of tokensA) if (setB.has(t)) matches++;
  return (matches / Math.min(tokensA.length, tokensB.length)) >= 0.5;
}

function extractTag(xmlBlock, tagName) {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xmlBlock.match(regex);
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
}

function extractLink(xmlBlock) {
  const atomHref = xmlBlock.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i) || xmlBlock.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (atomHref && atomHref[1]) return decodeEntities(atomHref[1]);
  return decodeEntities(extractTag(xmlBlock, "link"));
}

function cleanText(str) {
  if (!str) return "";
  return decodeEntities(str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeEntities(str) {
  if (!str) return "";
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeUrl(url) {
  if (!url) return "";
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function generateId(url) {
  const norm = normalizeUrl(url);
  let hash = 2166136261;
  for (let i = 0; i < norm.length; i++) { hash ^= norm.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return "fain_" + (hash >>> 0).toString(36);
}

async function loadStore(env) {
  if (env && env.FAIN_KV) {
    try {
      const data = await env.FAIN_KV.get(KV_STORE_KEY, "json");
      if (data && Array.isArray(data.items)) return data;
    } catch (e) { console.warn("Ошибка чтения KV:", e); }
  }
  return memoryFallbackStore;
}

async function saveStore(env, store) {
  memoryFallbackStore = store;
  if (env && env.FAIN_KV) {
    try {
      await env.FAIN_KV.put(KV_STORE_KEY, JSON.stringify(store));
    } catch (e) { console.warn("Ошибка записи KV:", e); }
  }
}
