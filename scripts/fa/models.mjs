// Единый реестр моделей FA и политика fallback.
// Порядок задаётся здесь или переменной FA_MODELS (repo variable), без дублей
// в workflow, agent-файлах и документации.
//
// Формат id совпадает с `opencode --model`: provider/model[#variant].

export const DEFAULT_MODELS = [
  {
    id: "anthropic/claude-haiku-5-5#low",
    label: "Claude Haiku 5.5",
    provider: "anthropic"
  },
  {
    id: "google/gemini-3.1-flash-lite#low",
    label: "Gemini 3.1 Flash-Lite low",
    provider: "google"
  }
];

// У каждого провайдера свой ключ. Ключ нужен только для платных моделей;
// бесплатные модели opencode работают без него.
const PROVIDER_KEYS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"]
};

const FREE_MODEL_RE = /^opencode\/[^#]*-free(?:#.*)?$/i;

export function isFreeModel(id) {
  return FREE_MODEL_RE.test(String(id || "").trim());
}

export function providerOf(id) {
  return String(id || "").split("/")[0] || "";
}

export function providerKeys(provider) {
  return PROVIDER_KEYS[provider] || [];
}

export function hasProviderKey(id, env = process.env) {
  if (isFreeModel(id)) return true;
  const keys = providerKeys(providerOf(id));
  if (keys.length === 0) return true; // провайдер настроен через `opencode auth`
  return keys.some((key) => Boolean(env[key]));
}

export function parseModels(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => {
      const known = DEFAULT_MODELS.find((model) => model.id === id);
      return known ? { ...known } : { id, label: id, provider: providerOf(id) };
    });
}

export function modelChain(env = process.env) {
  const configured = parseModels(env.FA_MODELS);
  const models = configured.length > 0 ? configured : DEFAULT_MODELS.map((model) => ({ ...model }));

  return models.map((model) => ({
    ...model,
    available: hasProviderKey(model.id, env),
    keyNames: providerKeys(model.provider)
  }));
}

export function availableModels(env = process.env) {
  return modelChain(env).filter((model) => model.available);
}

export function modelLabel(env = process.env) {
  return modelChain(env).map((model) => model.label).join(" -> ") || "none";
}

/**
 * Классификация ошибки модели. Переключение на следующую модель имеет смысл
 * только для quota/auth/unavailable; ошибки кода и verify остаются попытками задачи.
 */
export function classifyFailure(detail) {
  const text = String(detail || "");

  if (
    /provider\.quota|exceeded your current quota|free usage limit|rate[\s_-]?limit|too many requests|resource[_\s-]?exhausted|\b429\b/i.test(
      text
    )
  ) {
    return "quota";
  }

  if (
    /provider\.auth|unauthorized|invalid api key|authentication failed|permission[_\s-]?denied|\b401\b|\b403\b/i.test(
      text
    )
  ) {
    return "auth";
  }

  if (/overloaded|service unavailable|upstream|fetch failed|network|econn|etimedout|\b50[234]\b/i.test(text)) {
    return "unavailable";
  }

  return "other";
}
