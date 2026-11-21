// Единый реестр моделей FA, роли и классификация отказов.
//
// Порядок задаётся здесь или переменными окружения:
//   FA_MODELS              — общая цепочка fallback (provider/model[#variant])
//   FA_PLANNER_MODEL       — модель/цепочка для плана (elephant)
//   FA_EXECUTOR_MODEL      — модель/цепочка для реализации
//   FA_REPAIR_MODEL        — модель/цепочка для починки
//   FA_REVIEWER_MODEL      — модель/цепочка для независимого review (goldfish)
//   FA_AVAILABLE_MODELS    — белый список фактически доступных ID (из probe)
//   FA_EXCLUDE_MODELS      — чёрный список ID
//
// ID должны совпадать с `opencode models`.

import { spawnSync } from "node:child_process";

export const MODEL_ROLES = ["planner", "executor", "repair", "reviewer", "simple"];
export const ALLOWED_PROVIDERS = new Set(["google", "nvidia"]);
const DEFAULT_PROVIDER_ORDER = ["nvidia", "google"];
export const DEFAULT_MODEL_ORDER = {
  planner: [
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/glm-5.3-flash",
    "nvidia/minimax-m3.1-flash",
    "nvidia/laguna-xs-2.1",
    "google/gemini-4-hydrogen",
    "google/gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "google/gemini-2.5-flash"
  ],
  executor: [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/glm-5.3-flash",
    "nvidia/minimax-m3.1-flash",
    "nvidia/laguna-xs-2.1",
    "google/gemini-4-hydrogen",
    "google/gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "google/gemini-2.5-flash"
  ],
  repair: [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/glm-5.3-flash",
    "nvidia/minimax-m3.1-flash",
    "nvidia/laguna-xs-2.1",
    "google/gemini-4-hydrogen",
    "google/gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "google/gemini-2.5-flash"
  ],
  reviewer: [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/glm-5.3-flash",
    "nvidia/minimax-m3.1-flash",
    "nvidia/laguna-xs-2.1",
    "google/gemini-4-hydrogen",
    "google/gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "google/gemini-2.5-flash"
  ],
  simple: [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "google/gemini-3.5-flash-lite",
    "google/gemini-3.1-flash-lite"
  ]
};

// Google-модели идут после NVIDIA: их суточные квоты ограничены.
export const DEFAULT_MODELS = [
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_000_000,
    output: 8_192,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA NIM; primary model for coding and review roles"
  },
  {
    id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    label: "Nemotron 3.5 Super VL 120B (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_000_000,
    output: 32_768,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA NIM catalog; coding, tool-calling and multimodal agent model"
  },
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "Nemotron 3.5 Lightning 30B (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["simple"],
    context: 1_000_000,
    output: 8_192,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA NIM catalog; fast model for explicitly non-coding simple tasks"
  },
  {
    id: "nvidia/glm-5.3-flash",
    label: "GLM-5.3-Flash (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_048_576,
    output: 32_768,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA-hosted coding and tool-calling fallback"
  },
  {
    id: "nvidia/minimax-m3.1-flash",
    label: "MiniMax M3.1 Flash (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 200_000,
    output: 16_384,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA-hosted coding and agentic workflow fallback"
  },
  {
    id: "nvidia/laguna-xs-2.1",
    label: "Laguna XS 2.1 (NVIDIA NIM)",
    provider: "nvidia",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 262_144,
    output: 16_384,
    cost: { input: 0, output: 0 },
    notes: "NVIDIA-hosted agentic coding fallback"
  },
  {
    id: "google/gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    provider: "google",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_048_576,
    output: 65_536,
    rpm: 5,
    tpm: 250_000,
    dailyLimit: 20,
    quotaGroup: "google-standard",
    cost: { input: 0, output: 0 },
    notes: "Google code-capable fallback; shared standard Gemini quota"
  },
  {
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "google",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_048_576,
    output: 65_536,
    rpm: 5,
    tpm: 250_000,
    dailyLimit: 20,
    quotaGroup: "google-standard",
    cost: { input: 0, output: 0 },
    notes: "Google code-capable fallback; shared standard Gemini quota"
  },
  {
    id: "google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "google",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_048_576,
    output: 65_536,
    rpm: 5,
    tpm: 250_000,
    dailyLimit: 20,
    quotaGroup: "google-standard",
    cost: { input: 0, output: 0 },
    notes: "Google code-capable fallback; shared standard Gemini quota"
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    roles: ["planner", "executor", "repair", "reviewer"],
    context: 1_048_576,
    output: 65_536,
    rpm: 5,
    tpm: 250_000,
    dailyLimit: 20,
    quotaGroup: "google-standard",
    cost: { input: 0.3, output: 2.5 },
    notes: "Google code-capable fallback; shared standard Gemini quota"
  },
  {
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: "google",
    roles: ["simple"],
    context: 1_048_576,
    output: 65_536,
    rpm: 15,
    tpm: 250_000,
    dailyLimit: 500,
    quotaGroup: "google-lite",
    cost: { input: 0.1, output: 0.4 },
    notes: "Simple, non-coding tasks only"
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    provider: "google",
    roles: ["simple"],
    context: 1_048_576,
    output: 65_536,
    rpm: 15,
    tpm: 250_000,
    dailyLimit: 500,
    quotaGroup: "google-lite",
    cost: { input: 0, output: 0 },
    notes: "Simple, non-coding tasks only"
  }
];

// Gemini supports several independently quota-limited credentials.
const PROVIDER_KEYS = {
  google: [
    "GEMINI_API_KEY",
    "GEMINI_API_KEY_2",
    "GEMINI_API_KEY_3",
    "GEMINI_API_KEY_4",
    "GEMINI_API_KEY_5",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY"
  ],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"]
};

const FREE_MODEL_RE = /^opencode\/[^#]*-free(?:#.*)?$/i;

export function isFreeModel(id) {
  return FREE_MODEL_RE.test(String(id || "").trim());
}

export function providerOf(id) {
  return String(id || "").split("/")[0] || "";
}

export function modelNameOf(id) {
  const value = String(id || "");
  const slash = value.indexOf("/");
  return slash >= 0 ? value.slice(slash + 1).split("#")[0] : value.split("#")[0];
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

function splitList(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseModels(value) {
  return splitList(value).map((raw) => {
    const baseId = raw.replace(/#[a-z0-9-]+$/i, "");
    const known = DEFAULT_MODELS.find((model) => model.id === baseId);
    return known
      ? { ...known, id: raw, baseId, roles: [...known.roles] }
      : {
          id: raw,
          label: raw,
          provider: providerOf(raw),
          roles: [...MODEL_ROLES],
          context: 200_000,
          output: 32_000,
          tpm: 200_000,
          cost: { input: 0, output: 0 }
        };
  });
}

function availableFilter(env) {
  const allow = new Set(
    splitList(env.FA_AVAILABLE_MODELS).filter((id) => ALLOWED_PROVIDERS.has(providerOf(id)))
  );
  const deny = new Set(splitList(env.FA_EXCLUDE_MODELS));
  return (model) => {
    if (!ALLOWED_PROVIDERS.has(model.provider || providerOf(model.id))) return false;
    if (deny.has(model.id) || deny.has(model.id.replace(/#[a-z0-9-]+$/i, ""))) return false;
    if (allow.size > 0 && !allow.has(model.id)) return false;
    if (model.optional && env.FA_ALLOW_OPTIONAL === "false") return false;
    return true;
  };
}

function providerLimits(model, env) {
  if (model.provider !== "nvidia") return model;
  const limited = { ...model, quotaGroup: model.quotaGroup || "nvidia" };
  const limits = [
    ["rpm", "FA_NVIDIA_RPM"],
    ["tpm", "FA_NVIDIA_TPM"],
    ["dailyLimit", "FA_NVIDIA_RPD"]
  ];
  const missing = limits.filter(([, variable]) => env[variable] === undefined || env[variable] === "");
  if (missing.length > 0 && hasProviderKey(model.id, env)) {
    throw new Error(`set NVIDIA account rate limits: ${missing.map(([, variable]) => variable).join(", ")}`);
  }
  for (const [field, variable] of limits) {
    const raw = env[variable];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${variable} must be a non-negative integer`);
    }
    limited[field] = value;
  }
  return limited;
}

function prioritizeRole(models, role) {
  const modelOrder = DEFAULT_MODEL_ORDER[role] || [];
  return models.sort((left, right) => {
    const leftModel = modelOrder.indexOf(left.id);
    const rightModel = modelOrder.indexOf(right.id);
    if (leftModel >= 0 || rightModel >= 0) {
      return (leftModel < 0 ? Infinity : leftModel) - (rightModel < 0 ? Infinity : rightModel);
    }
    return DEFAULT_PROVIDER_ORDER.indexOf(left.provider) - DEFAULT_PROVIDER_ORDER.indexOf(right.provider);
  });
}

/**
 * Полная цепочка для отображения и fallback.
 * `FA_MODELS` задаёт предпочтения; стандартные модели дополняют цепочку fallback.
 */
export function modelChain(env = process.env) {
  const configured = parseModels(env.FA_MODELS);
  const filter = availableFilter(env);
  const allowedConfigured = configured.filter(filter);
  const configuredIds = new Set(allowedConfigured.map((model) => model.id));
  const models = [
    ...allowedConfigured,
    ...DEFAULT_MODELS
      .map((model) => ({ ...model }))
      .filter((model) => filter(model) && !configuredIds.has(model.id))
  ];

  return models
    .map((model) => ({
      ...providerLimits(model, env),
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
 * Модели роли. Если явная переменная роли пуста, берём модели с этой ролью.
 * Невалидные/удалённые из allowlist role-переопределения не блокируют запуск:
 * используется стандартный маршрут только через разрешённых провайдеров.
 */
export function modelsForRole(role, env = process.env, { fallback = true } = {}) {
  const explicit = splitList(env[`FA_${String(role).toUpperCase()}_MODEL`]);
  if (explicit.length > 0) {
    const selected = parseModels(explicit.join(","))
      .filter(availableFilter(env))
      .filter((model) => Array.isArray(model.roles) && model.roles.includes(role))
      .map((model) => ({
        ...providerLimits(model, env),
        role,
        available: hasProviderKey(model.id, env),
        keyNames: providerKeys(model.provider)
      }))
      .filter((model) => model.available);
    if (selected.length > 0) {
      const selectedIds = new Set(selected.map((model) => model.id));
      const fallbackModels = prioritizeRole(
        availableModels(env)
          .map((model) => ({ ...model, role }))
          .filter((model) => Array.isArray(model.roles) && model.roles.includes(role) && !selectedIds.has(model.id)),
        role
      );
      return [...selected, ...fallbackModels];
    }
  }

  const base = prioritizeRole(availableModels(env).map((model) => ({ ...model, role })), role);
  const preferred = base.filter((model) => Array.isArray(model.roles) && model.roles.includes(role));
  if (preferred.length > 0 || !fallback) return preferred;

  // Fallback: любая доступная модель, кроме явно несовместимых ролей.
  return base;
}

/**
 * Классификация ошибки модели. Переключение на следующую модель имеет смысл
 * только для quota/auth/unavailable/context; ошибки кода остаются попытками задачи.
 */
export function classifyFailure(detail) {
  const text = String(detail || "");

  if (
    /provider\.quota|exceeded your current quota|free usage limit|rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted|\b429\b/i.test(
      text
    )
  ) {
    return "quota";
  }

  if (
    /provider\.auth|unauthorized|invalid api key|authentication failed|permission[\s_-]?denied|\b401\b|\b403\b/i.test(
      text
    )
  ) {
    return "auth";
  }

  if (
    /overloaded|service unavailable|upstream|fetch failed|network|econn|etimedout|\b50[234]\b|(?:\b202\b|\b404\b|\b410\b)|invalid model reference|model not found|unknown model|no model is available|end of life|no longer available|retired model|request is pending/i.test(
      text
    )
  ) {
    return "unavailable";
  }

  // Контекстное окно и лимит вывода — свойство шага, а не задачи: лучше
  // переключиться на модель с большим окном, чем сжечь попытку.
  if (
    /context[\s_-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|token limit/i.test(
      text
    )
  ) {
    return "context";
  }

  return "other";
}

export function shouldFallback(category) {
  return category === "quota" || category === "auth" || category === "unavailable" || category === "context";
}

/** Причина, по которой fallback не поможет и задачу нужно отложить. */
export function isTransient(category) {
  return category === "quota" || category === "unavailable" || category === "context";
}

/** Оценка токенов по символам: дешёвая и стабильная, без токенизатора. */
export function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}

/** Список моделей, который видит установленный OpenCode (V2: `opencode models`). */
export function probeOpenCodeModels({ bin = process.env.FA_OPENCODE_BIN || "opencode", timeoutMs = 60_000 } = {}) {
  const result = spawnSync(bin, ["models"], { encoding: "utf8", timeout: timeoutMs });
  if (result.error) return { ok: false, reason: result.error.message, ids: [] };
  if (result.status !== 0) return { ok: false, reason: (result.stderr || "").trim().slice(0, 300), ids: [] };
  const ids = (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9-]+\/[^\s]+$/i.test(line));
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * Применяет найденные ID к опциональным моделям. Если модель объявлена как
 * optional и её нет в probe — она исключается. Для необязательных моделей
 * ID остаётся прежним: ключ важнее каталога.
 */
export function applyProbe(models, probeIds = []) {
  if (!Array.isArray(probeIds) || probeIds.length === 0) return models;
  const set = new Set(probeIds.map(String));
  const out = [];
  for (const model of models) {
    const baseId = model.id.replace(/#[a-z0-9-]+$/i, "");
    if (!model.optional) {
      out.push(model);
      continue;
    }
    if (set.has(baseId)) {
      out.push(model);
      continue;
    }
    const match = model.match ? [...set].find((id) => model.match.test(id)) : "";
    if (match) out.push({ ...model, id: match, match: undefined });
  }
  return out;
}

export function roleSummary(env = process.env) {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [role, modelsForRole(role, env).map((model) => model.id)])
  );
}

export const CROSS_VENDOR_PAIRS = [
  ["google", "nvidia"],
  ["nvidia", "google"]
];
