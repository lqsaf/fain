// Lifecycle state: durable run state, phase checkpoints и восстановление.
// Всё, что здесь лежит, — рантайм-артефакт в gitignored `fa/state`.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { PATHS, ROOT, makeRunId } from "./config.mjs";

const STATE_VERSION = 2;
const MAX_SAVED_RUNS = 5;

export function isSuccessfulRun({ failed = false, tasksBlocked = 0 } = {}) {
  return !failed && tasksBlocked === 0;
}

export function stateRoot(root = ROOT) {
  return process.env.FA_STATE_DIR || join(root, "fa/state");
}

export function runDir(runId, root = ROOT) {
  const safe = String(runId || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(stateRoot(root), "runs", safe);
}

export function activeFile(root = ROOT) {
  return join(stateRoot(root), "active.json");
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function createRunState({
  runId = makeRunId(),
  taskId = "",
  branch = "",
  baseSha = "",
  models = [],
  promptVersions = {},
  root = ROOT
} = {}) {
  pruneRunHistory(root, runId);
  const state = {
    version: STATE_VERSION,
    runId,
    taskId,
    branch,
    baseSha,
    phase: "init",
    attempt: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    models,
    promptVersions,
    phases: [],
    artifacts: {},
    checkpoints: [],
    pending: null,
    stopReason: ""
  };
  mkdirSync(runDir(runId, root), { recursive: true });
  saveRunState(state, { root });
  return state;
}

function pruneRunHistory(root, keepRunId) {
  const parent = join(stateRoot(root), "runs");
  if (!existsSync(parent)) return;
  const runs = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(parent, entry.name);
      return { name: entry.name, path, updatedAt: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = new Set([keepRunId, ...runs.filter((run) => run.name !== keepRunId).slice(0, MAX_SAVED_RUNS - 1).map((run) => run.name)]);
  for (const run of runs) {
    if (!keep.has(run.name)) rmSync(run.path, { recursive: true, force: true });
  }
}

export function saveRunState(state, { root = ROOT } = {}) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  atomicJson(join(runDir(next.runId, root), "state.json"), next);
  return next;
}

export function loadRunState(runId, { root = ROOT } = {}) {
  return readJson(join(runDir(runId, root), "state.json"));
}

export function setPhase(state, phase, extra = {}) {
  const next = {
    ...state,
    ...extra,
    phase,
    updatedAt: new Date().toISOString(),
    phases: [
      ...(state.phases || []),
      { phase, at: new Date().toISOString(), attempt: state.attempt || 0, ...(extra.phaseMeta || {}) }
    ]
  };
  delete next.phaseMeta;
  return next;
}

export function saveActive(state, { root = ROOT } = {}) {
  atomicJson(activeFile(root), state);
  saveRunState(state, { root });
}

export function loadActive({ root = ROOT } = {}) {
  return readJson(activeFile(root));
}

export function clearActive({ root = ROOT } = {}) {
  const file = activeFile(root);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Сохраняет diff рабочего дерева как checkpoint. */
export function saveCheckpoint(runId, { root = ROOT, patch = "", meta = {} } = {}) {
  const dir = runDir(runId, root);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `checkpoint-${meta.phase || "work"}.patch`);
  writeFileSync(file, patch || "", "utf8");
  const info = { file, phase: meta.phase || "work", at: new Date().toISOString(), ...meta };
  atomicJson(join(dir, "checkpoint.json"), info);
  return info;
}

export function readCheckpoint(runId, { root = ROOT } = {}) {
  const info = readJson(join(runDir(runId, root), "checkpoint.json"));
  if (!info || !existsSync(info.file)) return null;
  return { ...info, patch: readFileSync(info.file, "utf8") };
}

export function savePendingPush(state, { root = ROOT, patch = "", message = "" } = {}) {
  const dir = join(stateRoot(root), "pending");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "change.patch"), patch || "", "utf8");
  atomicJson(join(dir, "meta.json"), {
    taskId: state.taskId,
    runId: state.runId,
    branch: state.branch,
    baseSha: state.baseSha,
    message,
    at: new Date().toISOString()
  });
  return join(dir, "change.patch");
}

export function readPendingPush({ root = ROOT } = {}) {
  const meta = readJson(join(stateRoot(root), "pending", "meta.json"));
  const file = join(stateRoot(root), "pending", "change.patch");
  if (!meta || !existsSync(file)) return null;
  return { ...meta, patch: readFileSync(file, "utf8") };
}

export function clearPendingPush({ root = ROOT } = {}) {
  rmSync(join(stateRoot(root), "pending"), { recursive: true, force: true });
}

export function archiveRun(runId, reason = "", { root = ROOT } = {}) {
  const from = runDir(runId, root);
  if (!existsSync(from)) return "";
  const to = join(stateRoot(root), "archive", `${runId}-${Date.now()}`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  atomicJson(join(to, "archive.json"), { reason, at: new Date().toISOString() });
  return to;
}

/**
 * Можно ли продолжить прерванный запуск:
 * - задача всё ещё существует и не done;
 * - базовая ревизия не изменилась (иначе patch может не примениться);
 * - checkpoint существует, если фаза уже писала код.
 */
export function canResume(state, { task, headSha, baseSha } = {}) {
  if (!state || !state.runId || !state.taskId) return { ok: false, reason: "no state" };
  if (!task) return { ok: false, reason: "task is missing" };
  if (task.status === "done") return { ok: false, reason: "task is already done" };
  if (state.baseSha && baseSha && state.baseSha !== baseSha) {
    return { ok: false, reason: `base moved: ${state.baseSha.slice(0, 8)} -> ${baseSha.slice(0, 8)}` };
  }
  const needsPatch = ["implement", "repair", "verify", "review", "commit"].includes(state.phase);
  if (needsPatch && !readCheckpoint(state.runId)) {
    return { ok: false, reason: `no checkpoint for phase ${state.phase}` };
  }
  return { ok: true, reason: `resume at ${state.phase}` };
}

export function applyCheckpoint(runId, { root = ROOT } = {}) {
  const checkpoint = readCheckpoint(runId, { root });
  if (!checkpoint) return { ok: false, reason: "no checkpoint" };
  if (!checkpoint.patch.trim()) return { ok: true, empty: true };
  const result = spawnSync("git", ["apply", "--3way", checkpoint.file], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000
  });
  return {
    ok: result.status === 0,
    reason: (result.stderr || result.stdout || "").trim().slice(0, 500),
    file: checkpoint.file
  };
}

export function stateSummary(state) {
  if (!state) return null;
  return {
    version: state.version,
    runId: state.runId,
    taskId: state.taskId,
    phase: state.phase,
    attempt: state.attempt,
    branch: state.branch,
    baseSha: state.baseSha,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    phases: (state.phases || []).length,
    pending: state.pending || null
  };
}

function parseArgs(argv) {
  const out = { action: "show" };
  for (const arg of argv) {
    if (["show", "clear", "apply"].includes(arg)) out.action = arg;
    else if (!out.runId && /^[A-Za-z0-9._-]+$/.test(arg)) out.runId = arg;
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "clear") {
    clearActive();
    console.log("active state cleared");
    return;
  }
  if (options.action === "apply") {
    const active = loadActive();
    if (!active) {
      console.error("no active run");
      process.exitCode = 2;
      return;
    }
    const result = applyCheckpoint(active.runId);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const active = loadActive();
  const state = options.runId ? loadRunState(options.runId) : active;
  console.log(JSON.stringify(stateSummary(state) || { active: false }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`state failed: ${error.message}`);
    process.exitCode = 2;
  }
}
