// Единая конфигурация FA. Все лимиты читаются из окружения и живут в коде,
// а не в промпте: промпт модель может проигнорировать, конфиг — нет.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BRANCH = process.env.FA_BRANCH || "fa/work";
export const BASE_BRANCH = process.env.FA_BASE_BRANCH || "main";
export const AGENT = process.env.FA_AGENT || "fa";
export const PLANNER_AGENT = process.env.FA_PLANNER_AGENT || "fa-planner";
export const REVIEWER_AGENT = process.env.FA_REVIEWER_AGENT || "fa-reviewer";
export const OPENCODE_BIN = process.env.FA_OPENCODE_BIN || "opencode";
export const PROMPT_VERSION = "task-v2";
export const AGENT_PROMPT_VERSION = "fa-v2";

export const PATHS = {
  logs: join(ROOT, "fa/logs"),
  state: join(ROOT, "fa/state"),
  eval: join(ROOT, "fa/eval"),
  memory: join(ROOT, "fa/memory"),
  tmp: join(ROOT, "fa/tmp")
};

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function readFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

export const LIMITS = {
  taskTimeoutMs: readNumber("FA_TASK_TIMEOUT_MIN", 25) * 60_000,
  // Один запуск — ровно одна задача. 90 минут хватает на план, две реализации и review.
  runBudgetMs: readNumber("FA_RUN_BUDGET_MIN", 90) * 60_000,
  maxAttempts: Math.max(1, readNumber("FA_MAX_ATTEMPTS", 2)),
  maxRepairs: Math.max(0, readNumber("FA_MAX_REPAIRS", 2)),
  maxPlanRepairs: Math.max(0, readNumber("FA_MAX_PLAN_REPAIRS", 1)),
  tokenBudget: readNumber("FA_TOKEN_BUDGET", 2_000_000),
  maxInfraFailures: Math.max(1, readNumber("FA_MAX_INFRA_FAILURES", 3)),
  reviewTimeoutMs: readNumber("FA_REVIEW_TIMEOUT_MIN", 10) * 60_000,
  planTimeoutMs: readNumber("FA_PLAN_TIMEOUT_MIN", 12) * 60_000,
  specReviewTimeoutMs: readNumber("FA_SPEC_REVIEW_TIMEOUT_MIN", 8) * 60_000,
  verifyTimeoutMs: readNumber("FA_VERIFY_TIMEOUT_MIN", 5) * 60_000,
  uiTimeoutMs: readNumber("FA_UI_TIMEOUT_MIN", 4) * 60_000,
  rateWaitMaxMs: readNumber("FA_RATE_WAIT_MAX_SEC", 45) * 1000,
  contextChars: readNumber("FA_CONTEXT_CHARS", 60_000),
  memoryEntries: readNumber("FA_MEMORY_LIMIT", 6),
  maxDiffFiles: readNumber("FA_MAX_DIFF_FILES", 25),
  maxDiffLines: readNumber("FA_MAX_DIFF_LINES", 2500)
};

export const PHASES = {
  plan: readFlag("FA_PHASE_PLAN", true),
  specReview: readFlag("FA_PHASE_SPEC_REVIEW", true),
  implement: true,
  verify: true,
  ui: readFlag("FA_PHASE_UI", true),
  review: readFlag("FA_PHASE_REVIEW", true)
};

export function isCi() {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runPaths(runId) {
  const dir = join(PATHS.logs, runId);
  ensureDir(dir);
  return {
    dir,
    events: join(dir, "run.jsonl"),
    summary: join(dir, "summary.json"),
    status: join(PATHS.logs, "STATUS.md")
  };
}

/**
 * Kill switch: возвращает причину остановки или null.
 * FA_ENABLED=false — плановый выключатель; FA_STOP — аварийный файл.
 */
export function killSwitch() {
  if (process.env.FA_ENABLED === "false") return "FA_ENABLED=false";
  if (existsSync(join(ROOT, "FA_STOP"))) return "FA_STOP file present";
  return null;
}

export function budgetExhausted(startedAt, limits = LIMITS) {
  return Date.now() - startedAt >= limits.runBudgetMs;
}

export function remainingBudget(startedAt, limits = LIMITS) {
  return Math.max(0, limits.runBudgetMs - (Date.now() - startedAt));
}

/** Бюджет отдельной фазы не может превышать остаток запуска. */
export function phaseTimeout(startedAt, requestedMs) {
  return Math.max(0, Math.min(requestedMs, remainingBudget(startedAt)));
}
