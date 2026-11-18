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
            title: { type: "STRING" },
            summary: { type: "STRING" }
          },
          required: ["id", "title", "summary"]
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
            analysis: { type: "STRING" }
          },
          required: ["id", "analysis"]
        }
      }
    },
    required: ["analyses"]
  }
};

let modelRoundRobinIndex = 0;
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

    if (request.method === "POST" && url.pathname === "/refresh") {
      const updatedStore = await runHourlyPipeline(env);
      return new Response(JSON.stringify(updatedStore), { headers: CORS_HEADERS });
    }

    let store = await loadStore(env);

    if (!store.lastUpdated || store.items.length === 0) {
      store = await runHourlyPipeline(env);
    } else {
      const now = Date.now();
      store.items = cleanStoreItems(store.items, now);
    }

    return new Response(JSON.stringify(store), { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHourlyPipeline(env));
  }
};

// Основной конвейер сбора и обработки новостей
async function runHourlyPipeline(env) {
  const now = Date.now();
  const store = await loadStore(env);

  // 0. Очищаем базу от записей старше 30 дней, любых непереведенных карточек и дублей
  store.items = cleanStoreItems(store.items || [], now);

  const existingUrls = new Set(store.items.map(i => normalizeUrl(i.url)));
  const rawCandidates = await fetchAllRssFeeds(existingUrls, store.items, now);

  if (rawCandidates.length === 0) {
    store.lastUpdated = new Date(now).toISOString();
    await saveStore(env, store);
    return store;
  }

  const pool = rawCandidates.slice(0, 45);

  // КЛЮЧ 1: Отбор прорывных ИИ-новостей + жесткая группировка по темам
  const step1Prompt = `Ты — главный фильтр ИИ-новостей проекта fain.
Из списка кандидатов выбери только прорывные и значимые новости строго про ИИ (выход новых ИИ-моделей, важные ИИ-функции, значимые исследования и крупные события индустрии ИИ).
СТРОГИЕ ПРАВИЛА ОТСЕВА:
1. Отсекай новости, не связанные напрямую с искусственным интеллектом (обычные гаджеты, игры, 3D/VR-фильмы, общие обновления ОС и рекламные кейсы клиентов).
2. ПРАВИЛО ОДНОГО СЮЖЕТА: Если в списке несколько новостей про одно и то же устройство, модель, презентацию или корпоративный сюжет — выбери СТРОГО ОДНУ самую полную и обзорную новость, а все частные детали отбрось.
3. Выбери максимум ${MAX_BATCH_SIZE} новостей, каждая из которых должна быть на 100% уникальную тему.
Верни строго JSON-объект формата: {"selectedIds": [числа id из списка]}

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

  // КЛЮЧ 2: Семантическая проверка со старой базой (включая summary) и внутри пакета
  const publishedHistory = store.items.slice(0, 60).map(item => ({
    title: item.title,
    originalTitle: item.originalTitle,
    summary: item.summary
  }));

  const step2Prompt = `Ты — строгий тематический дедупликатор новостей.
Твоя задача — не допустить появления в ленте нескольких новостей на одну и ту же тему, сюжет или продукт.
1. Сравни новых кандидатов с "Уже опубликованными новостями". Отбрось кандидата, если этот продукт, релиз модели, устройство, судебный иск или сюжет УЖЕ освещались в опубликованных новостях — даже если заметка написана другим изданием или раскрывает мелкую новую деталь.
2. Сравни новых кандидатов МЕЖДУ СОБОЙ. Если среди кандидатов есть 2+ новости об одном и том же продукте, человеке или событии, оставь в uniqueIds только ОДНОГО кандидата.
Верни строго JSON-объект формата: {"uniqueIds": [числа id уникальных кандидатов]}

Уже опубликованные новости:
${JSON.stringify(publishedHistory)}

Новые кандидаты:
${JSON.stringify(candidates.map((c, idx) => ({
  id: idx,
  title: c.rawTitle,
  snippet: c.rawSnippet
})))}`;

  const step2Res = await callGeminiWithFallback(1, step2Prompt, STEP_SCHEMAS.step2, env);
  if (!Array.isArray(step2Res?.uniqueIds)) {
    console.warn("Шаг 2 (дедупликация) не вернул ответ, отменяем публикацию батча во избежание дублей.");
    return store;
  }

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

  // КЛЮЧ 3: Редактор — составляет заголовок и краткое описание СТРОГО на русском языке
  const step3Prompt = `Ты — минималистичный русскоязычный техно-редактор ИИ-новостника fain.
Для каждой новости ОБЯЗАТЕЛЬНО переведи и напиши НА РУССКОМ ЯЗЫКЕ:
1. "title": точный, информативный заголовок на русском языке без кликбейта и воды (названия компаний и проектов вроде OpenAI, Claude, llama.cpp можно оставлять латиницей, но сам заголовок обязан быть на русском языке).
2. "summary": суть новости в 2–3 предложениях на русском языке кратко, ясно и по делу (даже если snippet пустой или короткий — раскрой суть события по заголовку и источнику, никогда не пиши заглушек).
Верни строго JSON-объект формата:
{"articles": [{"id": число, "title": "...", "summary": "..."}]}

Новости:
${JSON.stringify(candidates.map((c, idx) => ({
  id: idx,
  source: c.source,
  title: c.rawTitle,
  snippet: c.rawSnippet
})))}`;

  const step3Res = await callGeminiWithFallback(2, step3Prompt, STEP_SCHEMAS.step3, env);
  if (!Array.isArray(step3Res?.articles) || step3Res.articles.length === 0) {
    console.warn("Шаг 3 (редактор) не вернул переводы, отменяем сохранение сырых английских новостей.");
    return store;
  }

  const articlesMap = new Map();
  for (const art of step3Res.articles) {
    const id = Number(art.id);
    if (!Number.isNaN(id) && isRussianText(art.title) && isRussianText(art.summary)) {
      articlesMap.set(id, {
        title: art.title.trim(),
        summary: art.summary.trim()
      });
    }
  }

  // Отсекаем любые кандидаты, которые не получили валидный русский перевод на Шаге 3
  const translatedCandidates = [];
  for (let i = 0; i < candidates.length; i++) {
    const ed = articlesMap.get(i);
    if (ed) {
      translatedCandidates.push({
        ...candidates[i],
        ruTitle: ed.title,
        ruSummary: ed.summary
      });
    }
  }

  if (translatedCandidates.length === 0) {
    console.warn("Ни один кандидат не прошел проверку русского перевода на Шаге 3.");
    return store;
  }

  // КЛЮЧ 4: Тегировщик — присваивает #релиз, #анонс, #исследование или пустую строку
  const step4Prompt = `Ты — классификатор ИИ-новостей.
Для каждой новости выбери строго один тег из списка:
- "#релиз" (если продукт, модель, функция или код уже вышли и доступны)
- "#анонс" (если функцию или модель только пообещали выпустить в будущем)
- "#исследование" (если речь о научной работе, бенчмарке или техническом открытии)
- "" (пустая строка, если ни один из трех тегов не подходит)

Верни строго JSON-объект формата:
{"tags": [{"id": число, "tag": "#релиз" | "#анонс" | "#исследование" | ""}]}

Новости:
${JSON.stringify(translatedCandidates.map((c, idx) => ({
  id: idx,
  title: c.ruTitle,
  summary: c.ruSummary
})))}`;

  const step4Res = await callGeminiWithFallback(3, step4Prompt, STEP_SCHEMAS.step4, env);
  const tagsMap = new Map();
  const validTags = new Set(["#релиз", "#анонс", "#исследование", ""]);
  if (Array.isArray(step4Res?.tags)) {
    for (const t of step4Res.tags) {
      const id = Number(t.id);
      const cleanTag = (t.tag || "").trim().toLowerCase();
      if (!Number.isNaN(id)) {
        tagsMap.set(id, validTags.has(cleanTag) ? cleanTag : "");
      }
    }
  }

  // КЛЮЧ 5: ИИ-аналитик — глубокий разбор на русском языке
  const step5Prompt = `Ты — ведущий ИИ-аналитик.
Для каждой новости напиши емкий аналитический разбор на русском языке (3–4 предложения):
как это повлияет на индустрию, что это значит для обычного пользователя или разработчиков, и в чем ключевое преимущество или подвох. Без воды и общих фраз.
Верни строго JSON-объект формата:
{"analyses": [{"id": число, "analysis": "..."}]}

Новости:
${JSON.stringify(translatedCandidates.map((c, idx) => ({
  id: idx,
  source: c.source,
  title: c.ruTitle,
  summary: c.ruSummary
})))}`;

  const step5Res = await callGeminiWithFallback(4, step5Prompt, STEP_SCHEMAS.step5, env);
  const analysisMap = new Map();
  if (Array.isArray(step5Res?.analyses)) {
    for (const a of step5Res.analyses) {
      const id = Number(a.id);
      if (!Number.isNaN(id) && isRussianText(a.analysis)) {
        analysisMap.set(id, a.analysis.trim());
      }
    }
  }

  // Собираем только полностью готовые русскоязычные карточки
  const newItems = [];
  for (let idx = 0; idx < translatedCandidates.length; idx++) {
    const c = translatedCandidates[idx];
    const analysis = analysisMap.get(idx);
    if (!analysis) continue;

    newItems.push({
      id: generateId(c.url),
      title: c.ruTitle,
      originalTitle: c.rawTitle,
      summary: c.ruSummary,
      analysis,
      tag: tagsMap.get(idx) ?? "",
      url: c.url,
      source: c.source,
      publishedAt: c.publishedAt
    });
  }

  store.items = cleanStoreItems([...newItems, ...store.items], now).slice(0, 50);
  store.lastUpdated = new Date(now).toISOString();

  await saveStore(env, store);
  return store;
}

// Вызов Gemini: основной ключ шага -> 6-й резервный ключ -> остальные ключи

async function callGeminiWithFallback(keyIndex, promptText, responseSchema, env) {
  const keys = getGeminiKeys(env);
  
  const primaryKey = keys[keyIndex];
  const sixthReserveKey = keys[5];

  // Порядок ключей: 1) целевой ключ шага, 2) 6-й резервный ключ, 3) остальные ключи
  const orderedKeys = Array.from(
    new Set([primaryKey, sixthReserveKey, ...keys].filter(Boolean))
  );

  const deadModels = new Set();

  for (const apiKey of orderedKeys) {
    // Идем строго по возрастанию сложности: 3.1-flash-lite -> 3.5-flash-lite -> 3.6-flash -> 3.8-flash
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const modelName = GEMINI_MODELS[i];
      if (deadModels.has(modelName)) continue;

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema
            }
          })
        });

        if (response.status === 404) {
          deadModels.add(modelName);
          continue;
        }

        if (!response.ok) {
          console.warn(`Модель ${modelName} (шаг #${keyIndex + 1}) вернула ${response.status}, переходим к следующей...`);
          continue;
        }

        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) continue;

        const cleanedJson = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        return JSON.parse(cleanedJson);
      } catch (err) {
        console.warn(`Ошибка модели ${modelName} на шаге #${keyIndex + 1}:`, err.message);
      }
    }
  }

  return null;
}

// Параллельный парсинг всех 13 RSS/Atom лент с пре-фильтрацией дублей и рекламы
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
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  const seenUrlsInBatch = new Set();
  const allItems = [];

  for (const res of results) {
    if (res.status !== "fulfilled" || !Array.isArray(res.value)) continue;
    for (const item of res.value) {
      const normUrl = normalizeUrl(item.url);
      if (!normUrl || existingUrls.has(normUrl) || seenUrlsInBatch.has(normUrl)) continue;

      // Отсекаем рекламные клиентские кейсы OpenAI
      if (normUrl.includes("/business/customer-stories/")) continue;

      // Алгоритмическая проверка на совпадение заголовков с базой и внутри пула
      const isDupInStore = existingItems.some(
        ex => isSimilarTitle(item.rawTitle, ex.originalTitle) || isSimilarTitle(item.rawTitle, ex.title)
      );
      const isDupInBatch = allItems.some(b => isSimilarTitle(item.rawTitle, b.rawTitle));
      if (isDupInStore || isDupInBatch) continue;

      seenUrlsInBatch.add(normUrl);
      allItems.push(item);
    }
  }

  return allItems.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

// Универсальный парсер RSS 2.0 (<item>) и Atom (<entry>)
function parseFeedXml(xml, sourceName, now) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];

  for (const block of blocks) {
    const rawTitle = stripPublisherSuffix(cleanText(extractTag(block, "title")));
    const link = extractLink(block);
    const dateStr =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated") ||
      extractTag(block, "dc:date");

    const rawDesc =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content:encoded") ||
      extractTag(block, "content");

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

// Проверка карточки на валидный русский перевод и отсутствие технических заглушек
function isRussianText(str) {
  return typeof str === "string" && str.trim().length > 3 && /[а-яёА-ЯЁ]/.test(str);
}

function isValidRussianItem(item) {
  if (!item || !item.id || !item.publishedAt) return false;
  if (!isRussianText(item.title) || !isRussianText(item.summary) || !isRussianText(item.analysis)) {
    return false;
  }
  if (item.summary.trim() === "Подробности доступны в источнике.") return false;
  return true;
}

// Синхронная очистка базы от старых, непереведенных и дублирующихся записей
function cleanStoreItems(items, now) {
  const sorted = items
    .filter(item => {
      if (!isValidRussianItem(item)) return false;
      const age = now - new Date(item.publishedAt).getTime();
      return !Number.isNaN(age) && age >= 0 && age <= THIRTY_DAYS_MS;
    })
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const unique = [];
  const seenIds = new Set();

  for (const item of sorted) {
    if (seenIds.has(item.id)) continue;
    const hasTopicDup = unique.some(
      u => isSimilarTitle(item.originalTitle, u.originalTitle) || isSimilarTitle(item.title, u.title)
    );
    if (hasTopicDup) continue;

    seenIds.add(item.id);
    unique.push(item);
  }

  return unique;
}

// Убираем хвосты названий изданий из Google News (например, " - TechCrunch", " - Politico")
function stripPublisherSuffix(text) {
  if (!text) return "";
  return text.replace(/\s+[-–—]\s+[A-Za-z0-9.&'\s]{2,35}$/, "").trim();
}

// Токенизация и проверка близости заголовков для отсева дублей до LLM
function tokenizeTitle(str) {
  if (!str) return [];
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that", "this", "its", "new", "now",
    "how", "why", "what", "launches", "announces", "introduces", "releases",
    "says", "after", "over", "into", "more", "about", "can", "will", "just",
    "как", "для", "что", "или", "при", "после", "из-за", "через", "компания",
    "представила", "выпустила", "анонсировала", "запустила", "новые", "новый"
  ]);
  return stripPublisherSuffix(str)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

function isSimilarTitle(titleA, titleB) {
  const tokensA = tokenizeTitle(titleA);
  const tokensB = tokenizeTitle(titleB);
  if (tokensA.length < 3 || tokensB.length < 3) return false;

  const setB = new Set(tokensB);
  let matches = 0;
  for (const t of tokensA) {
    if (setB.has(t)) matches++;
  }

  const overlap = matches / Math.min(tokensA.length, tokensB.length);
  return overlap >= 0.5;
}

function extractTag(xmlBlock, tagName) {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xmlBlock.match(regex);
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
}

function extractLink(xmlBlock) {
  const atomHref = xmlBlock.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i) ||
                   xmlBlock.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (atomHref && atomHref[1]) return decodeEntities(atomHref[1]);
  const rssLink = extractTag(xmlBlock, "link");
  return decodeEntities(rssLink);
}

function cleanText(str) {
  if (!str) return "";
  return decodeEntities(
    str
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeUrl(url) {
  if (!url) return "";
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function generateId(url) {
  const norm = normalizeUrl(url);
  let hash = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    hash ^= norm.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "fain_" + (hash >>> 0).toString(36);
}

async function loadStore(env) {
  if (env && env.FAIN_KV) {
    try {
      const data = await env.FAIN_KV.get(KV_STORE_KEY, "json");
      if (data && Array.isArray(data.items)) return data;
    } catch (e) {
      console.warn("Ошибка чтения KV:", e);
    }
  }
  return memoryFallbackStore;
}

async function saveStore(env, store) {
  memoryFallbackStore = store;
  if (env && env.FAIN_KV) {
    try {
      await env.FAIN_KV.put(KV_STORE_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn("Ошибка записи KV:", e);
    }
  }
}
