// Единая конфигурация FA. Все лимиты читаются из окружения и живут в коде,
// а не в промпте: промпт модель может проигнорировать, конфиг — нет.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BRANCH = process.env.FA_BRANCH || "fa/work";
export const BASE_BRANCH = process.env.FA_BASE_BRANCH || "main";
export const AGENT = "fa";
export const REVIEWER_AGENT = "fa-reviewer";
export const MODEL = process.env.FA_MODEL || "opencode/deepseek-v4.1-flash-free#high";
export const OPENCODE_BIN = process.env.FA_OPENCODE_BIN || "opencode";
export const PROMPT_VERSION = "task-v1";
export const AGENT_PROMPT_VERSION = "fa-v1";

export const PATHS = {
  logs: join(ROOT, "fa/logs"),
  state: join(ROOT, "fa/state"),
  eval: join(ROOT, "fa/eval")
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

export const LIMITS = {
  taskTimeoutMs: readNumber("FA_TASK_TIMEOUT_MIN", 25) * 60_000,
  runBudgetMs: readNumber("FA_RUN_BUDGET_MIN", 300) * 60_000,
  maxTasks: readNumber("FA_MAX_TASKS", 0),
  maxAttempts: Math.max(1, readNumber("FA_MAX_ATTEMPTS", 2)),
  tokenBudget: readNumber("FA_TOKEN_BUDGET", 2_000_000),
  maxInfraFailures: Math.max(1, readNumber("FA_MAX_INFRA_FAILURES", 3)),
  reviewTimeoutMs: readNumber("FA_REVIEW_TIMEOUT_MIN", 10) * 60_000
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

export function modelLabel() {
  return MODEL;
}
