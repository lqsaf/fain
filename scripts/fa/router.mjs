// Model router: роли, fallback, TPM-бюджет, circuit breaker и защита от перерасхода.
// Детерминированный слой без обращений к сети; probe передаётся снаружи.
// Состояние (rate ledger, breaker) переживает отдельные `opencode run` и
// сохраняется в gitignored `fa/state`, чтобы 250k TPM не сжигались пачкой.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIMITS, ROOT } from "./config.mjs";
import { MODEL_ROLES, applyProbe, modelsForRole, providerKeys, providerOf } from "./models.mjs";

const WINDOW_MS = 60_000;
const LEDGER_VERSION = 1;
const DAILY_LEDGER_VERSION = 1;

function quotaGroupFor(model) {
  if (model.quotaGroup) return model.quotaGroup;
  const provider = model.provider || providerOf(model.id);
  if (provider === "google") return model.id.includes("flash-lite") ? "google-lite" : "google-standard";
  if (provider === "nvidia") return "nvidia";
  return model.id;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateFile(name, root = ROOT, env = process.env) {
  return env.FA_ROUTER_STATE_DIR
    ? join(env.FA_ROUTER_STATE_DIR, name)
    : join(root, "fa/state", name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export class RateLedger {
  constructor({ now = Date.now, file = "" } = {}) {
    this.now = now;
    this.file = file;
    this.entries = [];
    if (file) this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return this;
    const data = readJson(this.file, null);
    if (!data || !Array.isArray(data.entries)) return this;
    this.entries = data.entries
      .filter((entry) => entry && Number.isFinite(entry.at) && Number.isFinite(entry.tokens))
      .map((entry) => ({
        at: entry.at,
        provider: String(entry.provider || ""),
        tokens: entry.tokens,
        model: String(entry.model || ""),
        quotaGroup: String(entry.quotaGroup || quotaGroupFor({ id: String(entry.model || ""), provider: String(entry.provider || "") })),
        id: String(entry.id || "")
      }));
    this.prune();
    return this;
  }

  save() {
    if (!this.file) return this;
    this.prune();
    atomicJson(this.file, { version: LEDGER_VERSION, at: new Date().toISOString(), entries: this.entries });
    return this;
  }

  prune(at = this.now()) {
    this.entries = this.entries.filter((entry) => at - entry.at < WINDOW_MS);
  }

  used(provider, at = this.now()) {
    this.prune(at);
    return this.entries
      .filter((entry) => entry.provider === provider)
      .reduce((sum, entry) => sum + entry.tokens, 0);
  }

  waitMs(model, estimateTokens, at = this.now()) {
    this.prune(at);
    const tpm = Number(model.tpm) || 0;
    if (model.tpm !== undefined && tpm === 0) return Infinity;
    if (model.rpm !== undefined && Number(model.rpm) === 0) return Infinity;
    if (tpm > 0 && estimateTokens > tpm) return Infinity;
    let tokenWait = 0;
    if (tpm > 0) {
      const used = this.used(model.provider || providerOf(model.id), at);
      const projected = used + Math.max(0, estimateTokens);
      if (projected > tpm) {
        const providerEntries = this.entries
          .filter((entry) => entry.provider === (model.provider || providerOf(model.id)))
          .sort((a, b) => a.at - b.at);
        let overflow = projected - tpm;
        for (const entry of providerEntries) {
          overflow -= entry.tokens;
          tokenWait = Math.max(tokenWait, WINDOW_MS - (at - entry.at) + 150);
          if (overflow <= 0) break;
        }
      }
    }

    const rpm = Number(model.rpm) || 0;
    let requestWait = 0;
    if (rpm > 0) {
      const quotaGroup = quotaGroupFor(model);
      const requests = this.entries
        .filter((entry) => (entry.quotaGroup || entry.model) === quotaGroup)
        .sort((a, b) => a.at - b.at);
      if (requests.length >= rpm) {
        requestWait = Math.max(0, WINDOW_MS - (at - requests[0].at) + 150);
      }
    }

    return Math.max(0, tokenWait, requestWait);
  }

  record(model, tokens, at = this.now(), id = "") {
    const value = Number(tokens) || 0;
    this.entries.push({
      at,
      provider: model.provider || providerOf(model.id),
      model: model.id || "",
      quotaGroup: quotaGroupFor(model),
      tokens: value,
      id
    });
    this.prune(at);
  }

  /** Заменяет резерв на фактическое потребление. */
  settle(reservation, actualTokens) {
    const entry = this.entries.find((item) => item.id === reservation.id);
    if (!entry || !(Number(actualTokens) > 0)) return this;
    entry.tokens = Number(actualTokens);
    return this;
  }

  snapshot() {
    this.prune();
    const out = {};
    for (const entry of this.entries) {
      out[entry.provider] = (out[entry.provider] || 0) + entry.tokens;
    }
    return out;
  }
}

export class DailyCallLedger {
  constructor({ now = Date.now, file = "" } = {}) {
    this.now = now;
    this.file = file;
    this.entries = {};
    if (file) this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return this;
    const data = readJson(this.file, null);
    if (data?.entries && typeof data.entries === "object") {
      this.entries = Object.fromEntries(
        Object.entries(data.entries).map(([day, counts]) => {
          if (!counts || typeof counts !== "object" || Array.isArray(counts)) return [day, {}];
          const migrated = { ...counts };
          for (const [id, count] of Object.entries(counts)) {
            if (!id.startsWith("google/")) continue;
            const group = id.includes("flash-lite") ? "google-lite" : "google-standard";
            migrated[group] = (migrated[group] || 0) + (Number(count) || 0);
            delete migrated[id];
          }
          return [day, migrated];
        })
      );
    }
    this.prune();
    return this;
  }

  save() {
    if (!this.file) return this;
    this.prune();
    atomicJson(this.file, { version: DAILY_LEDGER_VERSION, entries: this.entries });
    return this;
  }

  day(at = this.now()) {
    return new Date(at).toISOString().slice(0, 10);
  }

  used(model, at = this.now()) {
    return Number(this.entries[this.day(at)]?.[quotaGroupFor(model)]) || 0;
  }

  reserve(model, limit, at = this.now()) {
    const day = this.day(at);
    const quotaGroup = quotaGroupFor(model);
    const used = Number(this.entries[day]?.[quotaGroup]) || 0;
    if (used >= limit) return false;
    this.entries[day] = { ...(this.entries[day] || {}), [quotaGroup]: used + 1 };
    this.save();
    return true;
  }

  prune(at = this.now()) {
    const cutoff = this.day(at - 2 * 86_400_000);
    this.entries = Object.fromEntries(Object.entries(this.entries).filter(([day]) => day >= cutoff));
  }

  snapshot(at = this.now()) {
    return { day: this.day(at), ...(this.entries[this.day(at)] || {}) };
  }
}

export class Breaker {
  constructor({ file = "", now = Date.now, cooldownMs = Number(process.env.FA_BREAKER_COOLDOWN_SEC || 300) * 1000 } = {}) {
    this.now = now;
    this.file = file;
    this.cooldownMs = cooldownMs;
    this.entries = {};
    if (file) this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return this;
    const data = readJson(this.file, null);
    if (data && data.entries && typeof data.entries === "object") this.entries = data.entries;
    return this;
  }

  save() {
    if (!this.file) return this;
    atomicJson(this.file, { version: 1, at: new Date().toISOString(), entries: this.entries });
    return this;
  }

  isOpen(id, at = this.now()) {
    const entry = this.entries[id];
    return Boolean(entry && entry.until > at);
  }

  remainingMs(id, at = this.now()) {
    const entry = this.entries[id];
    return entry && entry.until > at ? entry.until - at : 0;
  }

  trip(id, category, reason = "") {
    if (!["quota", "auth", "unavailable"].includes(category)) return;
    const cooldown = category === "auth" ? Math.max(this.cooldownMs, 30 * 60_000) : this.cooldownMs;
    this.entries[id] = {
      category,
      reason: String(reason || "").slice(0, 300),
      until: this.now() + cooldown,
      at: new Date().toISOString()
    };
    this.save();
  }

  reset(id) {
    if (!(id in this.entries)) return;
    delete this.entries[id];
    this.save();
  }

  resetCategory(category) {
    const remaining = Object.fromEntries(
      Object.entries(this.entries).filter(([, entry]) => entry.category !== category)
    );
    if (Object.keys(remaining).length === Object.keys(this.entries).length) return;
    this.entries = remaining;
    this.save();
  }

  snapshot(at = this.now()) {
    return Object.fromEntries(
      Object.entries(this.entries)
        .filter(([, entry]) => entry.until > at)
        .map(([id, entry]) => [id, { ...entry, remainingMs: entry.until - at }])
    );
  }
}

export class ModelSession {
  constructor({ env = process.env, root = ROOT, now = Date.now, probeIds = [], tokenBudget = LIMITS.tokenBudget } = {}) {
    this.env = env;
    this.root = root;
    this.now = now;
    this.probeIds = probeIds;
    this.exhausted = new Map();
    this.reservations = [];
    this.tokenBudget = Math.max(0, Number(tokenBudget) || 0);
    this.tokensUsed = 0;
    this.reservedTokens = 0;
    this.nextReservationId = 0;
    this.credentialOffsets = new Map();
    const file = (name) => stateFile(name, root, env);
    this.ledger = new RateLedger({ now, file: file("rate.json") });
    this.dailyCalls = new DailyCallLedger({ now, file: file("daily-calls.json") });
    this.breaker = new Breaker({ now, file: file("breakers.json") });
  }

  candidates(role, { exclude = [], avoidProvider = "", includeOpen = false } = {}) {
    const models = applyProbe(modelsForRole(role, this.env), this.probeIds);
    const excluded = new Set([...exclude, ...(this.exhausted.get(role) || [])]);
    return models
      .filter((model) => !excluded.has(model.id))
      .filter((model) => includeOpen || !this.breaker.isOpen(model.id, this.now()))
      .sort((a, b) => {
        if (!avoidProvider) return 0;
        const aPenalty = a.provider === avoidProvider ? 1 : 0;
        const bPenalty = b.provider === avoidProvider ? 1 : 0;
        return aPenalty - bPenalty;
      });
  }

  credentialCount(model, env = this.env) {
    const credentials = providerKeys(model.provider || providerOf(model.id))
      .map((key) => env[key])
      .filter(Boolean);
    return new Set(credentials).size;
  }

  providerEnv(model, env = this.env) {
    const provider = model.provider || providerOf(model.id);
    const credentials = [...new Set(providerKeys(provider).map((key) => env[key]).filter(Boolean))];
    if (credentials.length === 0) return env;
    const offset = this.credentialOffsets.get(provider) || 0;
    const selected = credentials[Math.min(offset, credentials.length - 1)];
    const overrides = Object.fromEntries(
      providerKeys(provider).map((key) => [key, selected])
    );
    if (provider === "google") overrides.GEMINI_API_KEY = selected;
    if (provider === "nvidia") overrides.NVIDIA_API_KEY = selected;
    return { ...env, ...overrides };
  }

  rotateCredential(model, env = this.env) {
    const provider = model.provider || providerOf(model.id);
    const current = this.credentialOffsets.get(provider) || 0;
    if (current + 1 >= this.credentialCount(model, env)) return false;
    this.credentialOffsets.set(provider, current + 1);
    return true;
  }

  /**
   * Резервирует модель под фазу. Ждём не дольше maxWaitMs; иначе пробуем
   * следующего кандидата. Оценка контекста отсекает модели с малым окном.
   */
  async reserve(role, options = {}) {
    const {
      estimateTokens = 25_000,
      maxWaitMs = Number(this.env.FA_RATE_WAIT_MAX_SEC || 45) * 1000,
      sleepImpl = sleep
    } = options;

    const candidates = this.candidates(role, options);
    const outstanding = this.tokensUsed + this.reservedTokens + estimateTokens;
    if (outstanding > this.tokenBudget) {
      return {
        ok: false,
        budgetExhausted: true,
        reason: `run token budget exhausted (${this.tokensUsed} used + ${this.reservedTokens} reserved + ${estimateTokens} requested > ${this.tokenBudget})`,
        candidates: candidates.map((model) => model.id)
      };
    }
    if (candidates.length === 0) {
      return { ok: false, reason: `no available model for role ${role}`, candidates: [] };
    }

    let shortestWait = Infinity;
    const skipped = [];
    for (const model of candidates) {
      const configuredDailyLimit = model.dailyLimitEnv ? this.env[model.dailyLimitEnv] : undefined;
      const parsedDailyLimit = Number(configuredDailyLimit);
      let dailyLimit = Number(model.dailyLimit) || 0;
      if (configuredDailyLimit !== undefined && configuredDailyLimit !== "") {
        if (!Number.isSafeInteger(parsedDailyLimit) || parsedDailyLimit < 0) {
          throw new Error(`${model.dailyLimitEnv} must be a non-negative integer`);
        }
        dailyLimit = parsedDailyLimit;
      }
      const hasDailyLimit = Boolean(model.dailyLimitEnv) || model.dailyLimit !== undefined;
      if (hasDailyLimit && this.dailyCalls.used(model, this.now()) >= dailyLimit) {
        skipped.push(`${model.id}: daily request limit ${dailyLimit} reached`);
        continue;
      }
      if (estimateTokens > model.context * 0.9) {
        skipped.push(`${model.id}: context ${model.context} < estimate ${estimateTokens}`);
        continue;
      }
      const wait = this.ledger.waitMs(model, estimateTokens, this.now());
      if (!Number.isFinite(wait)) {
        skipped.push(`${model.id}: estimated request exceeds the provider TPM cap`);
        continue;
      }
      shortestWait = Math.min(shortestWait, wait);
      if (wait > maxWaitMs) {
        skipped.push(`${model.id}: rate limit ${Math.round(wait / 1000)}s`);
        continue;
      }
      if (wait > 0) await sleepImpl(wait);
      const reservation = {
        role,
        model,
        tokens: estimateTokens,
        at: this.now(),
        id: `${role}:${model.id}:${this.now()}:${++this.nextReservationId}`
      };
      if (hasDailyLimit && !this.dailyCalls.reserve(model, dailyLimit, reservation.at)) {
        skipped.push(`${model.id}: daily request limit ${dailyLimit} reached`);
        continue;
      }
      this.ledger.record(model, estimateTokens, reservation.at, reservation.id);
      this.ledger.save();
      this.reservations.push(reservation);
      this.reservedTokens += estimateTokens;
      return { ok: true, model, reservation, waitMs: wait, candidates: candidates.map((item) => item.id), skipped };
    }

    const reason = Number.isFinite(shortestWait)
      ? `all ${role} models are rate-limited (shortest wait ${Math.round(shortestWait / 1000)}s)`
      : `all ${role} models are unavailable: ${skipped.join("; ") || "no eligible candidates"}`;
    return {
      ok: false,
      reason,
      waitMs: shortestWait,
      candidates: candidates.map((item) => item.id),
      skipped
    };
  }

  /** Закрывает резерв фактическими токенами и обновляет breaker. */
  settle(reservation, { actualTokens = 0, category = "" } = {}) {
    if (!reservation) return;
    this.ledger.settle(reservation, actualTokens);
    this.ledger.save();
    this.reservedTokens = Math.max(0, this.reservedTokens - reservation.tokens);
    this.tokensUsed += Number(actualTokens) > 0 ? Number(actualTokens) : reservation.tokens;
    this.reservations = this.reservations.filter((item) => item.id !== reservation.id);
    if (category) {
      this.breaker.trip(reservation.model.id, category);
      this.exhausted.set(reservation.role, [
        ...(this.exhausted.get(reservation.role) || []),
        reservation.model.id
      ]);
    }
  }

  release(reservation) {
    if (!reservation) return;
    this.ledger.entries = this.ledger.entries.filter((entry) => entry.id !== reservation.id);
    this.ledger.save();
    this.reservedTokens = Math.max(0, this.reservedTokens - reservation.tokens);
    this.reservations = this.reservations.filter((item) => item.id !== reservation.id);
  }

  /** Модель сломалась на конкретном шаге, но роль должна продолжить. */
  failover(reservation, category, reason = "", actualTokens = 0) {
    this.settle(reservation, { category, actualTokens });
    if (category === "quota" || category === "unavailable" || category === "auth") {
      this.breaker.trip(reservation.model.id, category, reason);
    }
  }

  snapshot() {
    return {
      rate: this.ledger.snapshot(),
      dailyCalls: this.dailyCalls.snapshot(this.now()),
      breakers: this.breaker.snapshot(this.now()),
      exhausted: Object.fromEntries([...this.exhausted].map(([role, ids]) => [role, [...new Set(ids)]])),
      tokens: {
        budget: this.tokenBudget,
        used: this.tokensUsed,
        reserved: this.reservedTokens,
        remaining: Math.max(0, this.tokenBudget - this.tokensUsed - this.reservedTokens)
      }
    };
  }
}

/**
 * Кандидаты роли в порядке приоритета. `avoidProvider` поднимает наверх
 * модели другого провайдера — это нужно для goldfish review.
 */
export function roleCandidates(role, { env = process.env, probeIds = [], exclude = [], avoidProvider = "" } = {}) {
  const models = applyProbe(modelsForRole(role, env), probeIds);
  const excluded = new Set(exclude);
  return models
    .filter((model) => !excluded.has(model.id))
    .sort((a, b) => {
      if (!avoidProvider) return 0;
      const aPenalty = a.provider === avoidProvider ? 1 : 0;
      const bPenalty = b.provider === avoidProvider ? 1 : 0;
      return aPenalty - bPenalty;
    });
}

export function estimatePhaseTokens(role, { contextTokens = 20_000 } = {}) {
  const reserve = {
    planner: 12_000,
    executor: 40_000,
    repair: 30_000,
    reviewer: 16_000
  }[role] || 20_000;
  return Math.min(140_000, Math.max(8_000, contextTokens + reserve));
}

export function validateRouter({ env = process.env } = {}) {
  const problems = [];
  for (const role of MODEL_ROLES) {
    if (!roleCandidates(role, { env }).length) problems.push(`no model for role ${role}`);
  }
  return problems;
}

export { stateFile as routerStateFile };
