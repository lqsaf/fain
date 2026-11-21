#!/usr/bin/env node
// FA orchestrator v2: очередь → контекст → план (elephant) → goldfish review
// плана → реализация → детерминированные проверки + UI smoke → починка →
// независимый goldfish review → коммит → PR. Агент не коммитит и не пушит.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT,
  BASE_BRANCH,
  BRANCH,
  LIMITS,
  OPENCODE_BIN,
  PATHS,
  PHASES,
  PLANNER_AGENT,
  PROMPT_VERSION,
  REVIEWER_AGENT,
  ROOT,
  budgetExhausted,
  isCi,
  killSwitch,
  makeRunId,
  nowIso,
  phaseTimeout,
  runPaths
} from "./config.mjs";
import { modelChain, providerOf } from "./models.mjs";
import {
  findTask,
  markBlocked,
  markClaimed,
  markDone,
  readQueue,
  resetQuotaBlocks,
  resetStaleClaims,
  selectNext,
  writeQueue
} from "./queue.mjs";
import * as git from "./git.mjs";
import { flags } from "./metrics.mjs";
import { isAllowedVerifyCommand, isProtected } from "./policy.mjs";
import { prBody, statusMarkdown } from "./report.mjs";
import { buildContext, isUiTask } from "./context.mjs";
import {
  failureFingerprint,
  loadMemory,
  recordFailure,
  recordLesson,
  repeatedFailureTrend,
  searchMemory
} from "./memory.mjs";
import {
  applyCheckpoint,
  canResume,
  clearActive,
  createRunState,
  isSuccessfulRun,
  loadActive,
  saveActive,
  saveCheckpoint,
  setPhase
} from "./state.mjs";
import { ModelSession } from "./router.mjs";
import { createLogRecord } from "./logging.mjs";
import { flushTelemetry, recordTrace } from "./telemetry.mjs";
import { runPhase } from "./runner.mjs";
import {
  PROMPT_VERSIONS,
  buildImplementPrompt,
  buildPlanPrompt,
  buildPlanRepairPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  buildSpecReviewPrompt,
  promptVersionsLine,
  specReviewVerdict
} from "./prompts.mjs";
import { preflight, probeModels } from "./doctor.mjs";
import { runUiSmoke, uiSummary } from "./ui.mjs";

let run = null;
let cli = { noPush: false };
const state = {
  startedAt: Date.now(),
  runId: "",
  correlationId: "",
  taskId: "",
  taskStartedAt: 0,
  tasksDone: 0,
  tasksBlocked: 0,
  infraFailures: 0,
  tokenTotal: 0,
  budgetTokenTotal: 0,
  tasks: [],
  models: [],
  modelFallbacks: 0,
  activeModel: "",
  stopReason: "unknown",
  failed: false,
  phases: [],
  executorProvider: "",
  executorModel: "",
  plan: "",
  verify: null,
  ui: null,
  repairs: 0,
  reviewModel: "",
  reason: ""
};

function parseArgs(argv) {
  const options = {
    once: false,
    task: "",
    dryRun: false,
    preflight: false,
    noPush: false,
    forceLocal: false,
    noUi: false,
    noPlan: false,
    noReview: false,
    noResume: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--task") options.task = argv[++i] || "";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--preflight") options.preflight = true;
    else if (arg === "--no-push") options.noPush = true;
    else if (arg === "--force-local") options.forceLocal = true;
    else if (arg === "--no-ui") options.noUi = true;
    else if (arg === "--no-plan") options.noPlan = true;
    else if (arg === "--no-review") options.noReview = true;
    else if (arg === "--no-resume") options.noResume = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }

  return options;
}

function log(event, data = {}) {
  const detail = `${event} ${data.model || ""} ${data.phase || ""} ${data.category || ""} ${data.status || ""} ${data.message || ""} ${data.reason || ""}`.toLowerCase();
  const isFailure =
    /(?:error|failed|fatal|fallback|blocked|budget_exhausted|retry|infra|exhausted)/.test(event) ||
    /^(?:error|failed|infra|exhausted|blocked)$/.test(String(data.status || ""));
  const layer = /(?:verify|ui|eval)\./.test(event)
    ? "V"
    : /(?:context|memory)\./.test(event)
      ? "C"
      : /(?:tool|mcp)\./.test(event)
        ? "T"
        : /(?:policy|protected)\./.test(event)
          ? "G"
          : /(?:model|quota|auth|rate.limit)/.test(detail)
            ? "O"
            : /timeout|budget|spawn/.test(detail)
              ? "E"
              : /(?:task|queue|branch|run)\./.test(event)
                ? "L"
                : "E";
  const taggedData = isFailure ? { ...data, layer } : data;
  const taskId = taggedData.task || state.taskId;
  const correlationId = data.correlationId ||
    (taskId && taskId === state.taskId && state.correlationId
      ? state.correlationId
      : `${state.runId || "fa"}:run`);
  const record = createLogRecord({
    at: nowIso(),
    runId: state.runId,
    taskId,
    correlationId,
    event,
    data: taggedData
  });
  recordTrace(record);
  if (run) appendFileSync(run.events, `${JSON.stringify(record)}\n`);
  const task = data.task ? `[${data.task}] ` : "";
  const phase = data.phase ? `${data.phase}: ` : "";
  const model = data.model ? `${data.model} ` : "";
  const message = data.message ? ` ${data.message}` : "";
  console.log(`${record.at} ${event} [corr:${correlationId}] ${task}${phase}${model}${message}`.trimEnd());
}

function sanitize(value) {
  return String(value || "")
    .replace(/AIza[0-9A-Za-z_-]{35}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted]");
}

function requireCleanWorktree() {
  if (!git.isClean()) {
    throw new Error("worktree is dirty; FA needs a clean tree (commit or stash your changes first)");
  }
}

function remainingExecutionMs() {
  const runRemaining = phaseTimeout(state.startedAt, LIMITS.runBudgetMs);
  const taskRemaining = state.taskStartedAt
    ? Math.max(0, LIMITS.taskTimeoutMs - (Date.now() - state.taskStartedAt))
    : Infinity;
  return Math.min(runRemaining, taskRemaining);
}

function phaseTimeoutForTask(requestedMs) {
  return Math.max(0, Math.min(requestedMs, remainingExecutionMs()));
}

function isSimpleNonCodeTask(task) {
  const textFile = /\.(?:md|mdx|txt|rst|adoc)$/i;
  return task?.area === "simple" &&
    Array.isArray(task.files) &&
    task.files.length > 0 &&
    task.files.every(
      (file) =>
        textFile.test(file) &&
        !file.includes("*") &&
        !file.includes("?") &&
        !file.includes("[") &&
        !file.includes("]")
    );
}

function roleForTask(task, role) {
  return isSimpleNonCodeTask(task) ? "simple" : role;
}

function ghAvailable() {
  const result = spawnSync("gh", ["--version"], { encoding: "utf8", timeout: 15_000 });
  return !result.error && result.status === 0;
}

function gh(args, input) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    timeout: 60_000,
    env: process.env
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim()
  };
}

function prState() {
  if (!ghAvailable() || !process.env.GH_TOKEN) return null;
  const result = gh(["pr", "view", BRANCH, "--json", "state,number,url"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function createIssue(title, body) {
  if (!ghAvailable() || !process.env.GH_TOKEN) return;

  const listed = gh(["issue", "list", "--state", "open", "--search", `in:title "${title}"`, "--json", "number,title", "--limit", "100"]);
  if (!listed.ok) {
    log("issue.lookup.error", { message: listed.stderr.slice(0, 300) });
    return;
  }

  let existing;
  try {
    const issues = JSON.parse(listed.stdout || "[]");
    existing = issues.find((issue) => issue.title === title);
  } catch (error) {
    log("issue.lookup.error", { message: `invalid GitHub issue response: ${error.message}` });
    return;
  }

  if (existing) {
    const updated = gh(["issue", "edit", String(existing.number), "--body-file", "-"], body);
    if (updated.ok) log("issue.update", { message: `#${existing.number} refreshed: ${title}` });
    else log("issue.update.error", { message: updated.stderr.slice(0, 300) });
    return;
  }

  const result = gh(["issue", "create", "--title", title, "--body-file", "-"], body);
  if (result.ok) log("issue.create", { message: result.stdout.split("\n").pop() || title });
  else log("issue.error", { message: result.stderr.slice(0, 300) });
}

function createImprovementProposal(fingerprint, trend) {
  if (!ghAvailable() || !process.env.GH_TOKEN) {
    log("improvement.skip", { message: `recurring failure ${fingerprint}; GitHub issue integration unavailable` });
    return;
  }
  const title = `FA improvement proposal: recurring failure ${fingerprint}`;
  const listed = gh(["issue", "list", "--state", "open", "--search", `in:title "${title}"`, "--json", "number,title"]);
  if (!listed.ok) {
    log("improvement.lookup.error", { message: listed.stderr.slice(0, 300) });
    return;
  }
  let issues;
  try {
    issues = JSON.parse(listed.stdout || "[]");
  } catch (error) {
    log("improvement.lookup.error", { message: `invalid GitHub issue response: ${error.message}` });
    return;
  }
  if (issues.some((issue) => issue.title === title)) {
    log("improvement.duplicate", { message: title });
    return;
  }

  const evidence = trend.entries.map((entry) =>
    `- ${entry.task || "unknown task"} / ${entry.phase || "unknown phase"} / ${entry.model || "unknown model"}: ${sanitize(entry.text).slice(0, 500)}`
  );
  const body = [
    "This is an automatically generated harness-improvement proposal based on recurring failure observations.",
    "It does not modify TASKS.md or execute the proposed work automatically.",
    "",
    `Fingerprint: \`${fingerprint}\``,
    `Occurrences: ${trend.occurrences} across ${trend.tasks.length} tasks`,
    "",
    "## Recent evidence",
    ...evidence,
    "",
    "Please investigate whether the repeated pattern indicates a harness defect, improve its verification or recovery path if appropriate, and close this issue with the outcome."
  ].join("\n");
  const result = gh(["issue", "create", "--title", title, "--body-file", "-"], body);
  if (result.ok) log("improvement.created", { message: result.stdout.split("\n").pop() || title });
  else log("improvement.create.error", { message: result.stderr.slice(0, 300) });
}

function ensurePr() {
  if (!ghAvailable() || !process.env.GH_TOKEN) {
    log("pr.skip", { message: "gh or GH_TOKEN is unavailable" });
    return null;
  }

  const list = gh(["pr", "list", "--head", BRANCH, "--base", BASE_BRANCH, "--state", "open", "--json", "number", "--jq", ".[0].number"]);
  if (list.ok && list.stdout) {
    const number = Number(list.stdout);
    const body = prBody(readQueue(), readSummary());
    gh(["pr", "edit", String(number), "--body-file", "-"], body);
    log("pr.update", { message: `#${number}` });
    return number;
  }

  const body = prBody(readQueue(), readSummary());
  const created = gh(
    [
      "pr",
      "create",
      "--head",
      BRANCH,
      "--base",
      BASE_BRANCH,
      "--title",
      `FA: ${readQueue().filter((task) => task.status === "done").length} tasks`,
      "--body-file",
      "-"
    ],
    body
  );

  if (!created.ok) {
    log("pr.error", { message: created.stderr.slice(0, 500) });
    return null;
  }

  const url = created.stdout.split("\n").pop() || "";
  log("pr.create", { message: url });
  const number = Number(url.split("/").pop());
  return Number.isFinite(number) ? number : null;
}

function readSummary() {
  const file = join(PATHS.logs, "latest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pushWithRetry() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = git.git(["push", "origin", `HEAD:refs/heads/${BRANCH}`], { allowFailure: true, timeout: 180_000 });
    if (result.code === 0) return true;
    log("git.push.retry", { message: `attempt ${attempt}: ${result.stderr.slice(0, 300)}` });
  }
  return false;
}

function readQueueText() {
  return readFileSync(join(ROOT, "TASKS.md"), "utf8");
}

function diffForReview() {
  // Новые файлы должны попасть в diff; TASKS.md — состояние очереди, его review не нужен.
  git.git(["add", "-A"], { allowFailure: true });
  return git.git(["diff", "--no-color", "HEAD", "--", ".", ":(exclude)TASKS.md"], { allowFailure: true }).stdout;
}

function diffStatForRepair() {
  git.git(["add", "-A"], { allowFailure: true });
  return git.git(["diff", "--stat", "HEAD", "--", ".", ":(exclude)TASKS.md"], { allowFailure: true }).stdout;
}

function changedForCommit() {
  return git.changedFiles().filter((file) => file !== "TASKS.md");
}

function guardDiff(changed) {
  const agentFiles = changed.filter((file) => file !== "TASKS.md");
  const problems = [];
  const protectedChanged = agentFiles.filter(isProtected);
  if (protectedChanged.length > 0) problems.push(`protected files changed: ${protectedChanged.join(", ")}`);
  if (agentFiles.length > LIMITS.maxDiffFiles) problems.push(`${agentFiles.length} files changed > ${LIMITS.maxDiffFiles}`);
  const numstat = git.git(["diff", "--numstat", "HEAD", "--", ".", ":(exclude)TASKS.md"]).stdout;
  const changedLines = numstat
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => {
      const [added, deleted] = line.split("\t");
      return total + (Number(added) || 0) + (Number(deleted) || 0);
    }, 0);
  if (changedLines > LIMITS.maxDiffLines) {
    problems.push(`${changedLines} diff lines > ${LIMITS.maxDiffLines}`);
  }
  return problems;
}

function verifyResultToText(verify) {
  if (!verify) return "";
  return [
    `ok: ${verify.ok}`,
    `checks: ${verify.checkCount || 0}`,
    ...(verify.errors || []).map((error) => `ERROR ${error}`)
  ].join("\n");
}

function runVerify(taskId) {
  const file = join(run.dir, `verify-${taskId}.json`);
  const timeoutMs = Math.min(LIMITS.verifyTimeoutMs, remainingExecutionMs());
  if (timeoutMs <= 0) {
    const result = { ok: false, errors: [{ name: "deadline", message: "execution deadline exhausted before verification" }], checks: [] };
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return { ok: false, errors: ["execution deadline exhausted before verification"], checks: [], checkCount: 0, file };
  }
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/verify.mjs"), "--json", "--diff", "HEAD", "--protected", "--allow-tasks"],
    { cwd: ROOT, encoding: "utf8", timeout: timeoutMs }
  );

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }

  writeFileSync(
    file,
    result.stdout || JSON.stringify({ ok: false, errors: [{ message: result.stderr }] }, null, 2),
    "utf8"
  );

  const checks = parsed?.checks || [];
  if (result.status === 0 && parsed?.ok) {
    return { ok: true, errors: [], checks, checkCount: checks.length, file };
  }
  return {
    ok: false,
    errors:
      parsed?.errors?.map((error) => `${error.name}: ${error.message}`) ||
      [result.stderr.trim() || "verify failed"],
    checks,
    checkCount: checks.length,
    file
  };
}

function runTaskVerify(task) {
  const command = String(task.verify || "").trim();
  if (!command || command === "node scripts/verify.mjs") return { ok: true, skipped: true, detail: "" };
  if (!isAllowedVerifyCommand(command)) {
    return { ok: false, skipped: false, detail: `verify command is not allowed: ${command}` };
  }

  const parts = command.split(/\s+/);
  const bin = parts[0] === "node" ? process.execPath : parts[0];
  const timeoutMs = Math.min(300_000, remainingExecutionMs());
  if (timeoutMs <= 0) {
    return { ok: false, skipped: false, detail: "execution deadline exhausted before task verification" };
  }
  const result = spawnSync(bin, parts.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs
  });

  return {
    ok: result.status === 0,
    skipped: false,
    detail: (result.stdout || result.stderr || "").trim().slice(-2000)
  };
}

async function runUiCheck(task) {
  if (!PHASES.ui || cli.noUi) return { ok: true, skipped: true, reason: "disabled" };
  if (!isUiTask(task)) return { ok: true, skipped: true, reason: "not a UI task" };
  const timeoutMs = Math.min(LIMITS.uiTimeoutMs, remainingExecutionMs());
  if (timeoutMs <= 0) {
    return { ok: false, skipped: false, reason: "execution deadline exhausted before UI smoke", errors: ["execution deadline exhausted before UI smoke"], checks: [] };
  }
  const result = await runUiSmoke({
    task,
    outDir: join(run.dir, "ui"),
    requireBrowser: process.env.FA_UI_REQUIRED === "true",
    timeoutMs
  });
  writeFileSync(join(run.dir, "ui.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function uiFailures(ui) {
  if (!ui || ui.ok) return "";
  return (ui.errors || []).join("\n");
}

function verifyFailures(verify, taskVerify) {
  const parts = [];
  if (verify && !verify.ok) parts.push(...(verify.errors || []));
  if (taskVerify && !taskVerify.ok) parts.push(`task verify: ${taskVerify.detail}`);
  return parts.join("\n");
}

function writeArtifact(name, value) {
  const file = join(run.dir, name);
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function rememberPhase(phase, result, extra = {}) {
  const entry = {
    phase,
    model: result?.model || "",
    tokens: result?.metrics?.tokenTotal || 0,
    cost: Number(result?.metrics?.cost) || 0,
    budgetTokens: result?.metrics?.budgetTokens ?? result?.metrics?.tokenTotal ?? 0,
    durationMs: result?.durationMs || 0,
    status: result?.kind || "ok",
    fallbacks: result?.fallbacks || 0,
    at: nowIso(),
    ...extra
  };
  state.phases.push(entry);
  state.tokenTotal += entry.tokens;
  state.budgetTokenTotal += entry.budgetTokens;
  if (entry.model) state.activeModel = entry.model;
  state.modelFallbacks += entry.fallbacks;
  log("phase.finish", {
    phase,
    model: entry.model,
    message: `${entry.status}, ${entry.tokens} actual / ${entry.budgetTokens} budgeted tokens, ${Math.round(entry.durationMs / 1000)}s${entry.fallbacks ? `, fallbacks=${entry.fallbacks}` : ""}`
  });
  return entry;
}

function persistState(phaseName, extra = {}) {
  if (!state.runId) return;
  let current = null;
  try {
    current = loadActive();
  } catch {
    current = null;
  }
  const base =
    current && current.runId === state.runId
      ? current
      : createRunState({
          runId: state.runId,
          taskId: state.taskId,
          branch: BRANCH,
          baseSha: git.headSha(),
          models: state.models.map((model) => model.id),
          promptVersions: PROMPT_VERSIONS
        });
  const next = setPhase(base, phaseName, {
    attempt: extra.attempt ?? base.attempt ?? 0,
    artifacts: { ...(base.artifacts || {}), ...(extra.artifacts || {}) },
    pending: extra.pending || null,
    models: state.models.map((model) => model.id)
  });
  saveActive(next);
}

async function phasePlan({ task, context, memory, attempt }) {
  const prompt = buildPlanPrompt({ task, context: context.text, memory });
  log("phase.start", { phase: "plan", message: `attempt ${attempt}` });
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "planner"),
    agent: PLANNER_AGENT,
    prompt,
    title: `FA plan ${task.id} attempt ${attempt}`,
    timeoutMs: phaseTimeoutForTask(LIMITS.planTimeoutMs),
    runDir: run.dir,
    fileBase: `${task.id}-attempt${attempt}-plan`,
    taskId: task.id,
    markers: ["PLAN_READY"],
    log
  });
  rememberPhase("plan", result, { attempt });
  if (result.kind === "ok") {
    state.plan = result.text;
    persistState("spec-review", {
      attempt,
      artifacts: { plan: writeArtifact(`plan-${task.id}-${attempt}.md`, result.text) }
    });
  }
  return result;
}

async function phaseSpecReview({ task, context, plan, attempt }) {
  const prompt = buildSpecReviewPrompt({ task, plan, context: context.text });
  const plannerModel = [...state.phases]
    .reverse()
    .find((phase) => phase.phase === "plan" || phase.phase === "plan-repair")?.model;
  log("phase.start", { phase: "spec-review" });
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "reviewer"),
    agent: REVIEWER_AGENT,
    prompt,
    title: `FA spec review ${task.id} attempt ${attempt}`,
    timeoutMs: phaseTimeoutForTask(LIMITS.specReviewTimeoutMs),
    runDir: run.dir,
    fileBase: `${task.id}-attempt${attempt}-spec`,
    taskId: task.id,
    markers: [],
    excludeModels: plannerModel ? [plannerModel] : [],
    log
  });
  rememberPhase("spec-review", result, { attempt });
  if (result.kind !== "ok") return { ...result, verdict: "ERROR" };
  const verdict = specReviewVerdict(result.text);
  if (verdict === "PASS" && /^\s*VERDICT:\s*FAIL\s*$/im.test(result.text)) {
    log("spec-review.minor-only", {
      phase: "spec-review",
      model: result.model,
      message: "review returned FAIL with minor-only findings; allowing implementation"
    });
  }
  return { ...result, verdict };
}

async function phasePlanRepair({ task, context, plan, findings, attempt }) {
  const prompt = buildPlanRepairPrompt({ task, plan, findings, context: context.text });
  log("phase.start", { phase: "plan-repair" });
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "planner"),
    agent: PLANNER_AGENT,
    prompt,
    title: `FA plan repair ${task.id}`,
    timeoutMs: phaseTimeoutForTask(LIMITS.planTimeoutMs),
    runDir: run.dir,
    fileBase: `${task.id}-attempt${attempt}-plan-repair`,
    taskId: task.id,
    markers: ["PLAN_READY"],
    log
  });
  rememberPhase("plan-repair", result, { attempt });
  if (result.kind === "ok") state.plan = result.text;
  return result;
}

async function phaseImplement({ task, context, plan, memory, attempt, previousFailure }) {
  const prompt = buildImplementPrompt({ task, plan, context: context.text, memory, attempt, previousFailure });
  log("phase.start", { phase: "implement", message: `attempt ${attempt}` });
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "executor"),
    agent: AGENT,
    prompt,
    title: `FA ${task.id} attempt ${attempt}`,
    timeoutMs: phaseTimeoutForTask(LIMITS.taskTimeoutMs),
    runDir: run.dir,
    fileBase: `${task.id}-attempt${attempt}-implement`,
    taskId: task.id,
    markers: ["DONE"],
    log
  });
  rememberPhase("implement", result, { attempt });
  if (result.kind === "ok") {
    state.executorProvider = providerOf(result.model);
    state.executorModel = result.model;
    state.modelsUsed = [...(state.modelsUsed || []), result.model];
    saveCheckpoint(state.runId, { patch: checkpointPatch(), meta: { phase: "implement", attempt } });
    persistState("verify", { attempt, artifacts: { checkpoint: join(run.dir, "checkpoint.json") } });
  }
  return result;
}

async function phaseRepair({ task, context, plan, verify, ui, attempt, round }) {
  const failure = verifyFailures(verify, null);
  const prompt = buildRepairPrompt({
    task,
    plan,
    context: context.text,
    failure: failure || uiFailures(ui) || "review failed",
    attempt,
    diffStat: diffStatForRepair(),
    ui: uiFailures(ui)
  });
  log("phase.start", { phase: "repair", message: `round ${round}` });
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "repair"),
    agent: AGENT,
    prompt,
    title: `FA repair ${task.id} round ${round}`,
    timeoutMs: phaseTimeoutForTask(Math.min(LIMITS.taskTimeoutMs, LIMITS.repairTimeoutMs)),
    runDir: run.dir,
    fileBase: `${task.id}-repair${round}`,
    taskId: task.id,
    markers: ["DONE"],
    log
  });
  rememberPhase("repair", result, { round });
  if (result.kind === "ok") {
    state.repairs += 1;
    state.executorProvider = providerOf(result.model);
    state.executorModel = result.model;
    saveCheckpoint(state.runId, { patch: checkpointPatch(), meta: { phase: "repair", round } });
    persistState("verify", { attempt, artifacts: { checkpoint: join(run.dir, "checkpoint.json") } });
  }
  return result;
}

async function phaseReview({ task, context, plan, verify, ui, attempt, round }) {
  const prompt = buildReviewPrompt({
    task,
    plan,
    context: context.text,
    diff: diffForReview(),
    verify: verifyResultToText(verify),
    ui: uiSummary(ui || { skipped: true }),
    flags: []
  });
  log("phase.start", { phase: "review", message: `round ${round}` });
  const excludeModels = [state.executorModel].filter(Boolean);
  const result = await runPhase({
    session: state.session,
    role: roleForTask(task, "reviewer"),
    agent: REVIEWER_AGENT,
    prompt,
    title: `FA review ${task.id} round ${round}`,
    timeoutMs: phaseTimeoutForTask(LIMITS.reviewTimeoutMs),
    runDir: run.dir,
    fileBase: `${task.id}-review${round}`,
    taskId: task.id,
    markers: [],
    excludeModels,
    log
  });
  rememberPhase("review", result, { round });
  if (result.kind !== "ok") return { ...result, verdict: "ERROR" };
  state.reviewModel = result.model;
  const verdict = /VERDICT:\s*PASS/i.test(result.text) ? "PASS" : "FAIL";
  return { ...result, verdict };
}

function checkpointPatch() {
  git.git(["add", "-A"], { allowFailure: true });
  return git.git(["diff", "--binary", "HEAD", "--", ".", ":(exclude)TASKS.md"], { allowFailure: true }).stdout;
}

function recordTask(task, fields) {
  state.tasks.push({
    id: task.id,
    title: task.title,
    attempts: fields.attempts,
    result: fields.result,
    files: fields.files || [],
    tokens: fields.tokens || 0,
    durationMs: fields.durationMs || 0,
    model: fields.model || "",
    reason: sanitize(fields.reason || "")
  });
}

function blockTask(task, reason, attempts) {
  const text = readQueueText();
  writeQueue(markBlocked(text, task.id, sanitize(reason)));
  state.failed = true;
  const message = `chore(fa): block ${task.id}`;
  git.commitAll(message, [`FA-Task: ${task.id}`, `Reason: ${sanitize(reason).slice(0, 400)}`]);
  if (!cli.noPush) pushWithRetry();
  createIssue(
    `FA blocked: ${task.id}`,
    `Задача ${task.id} заблокирована.\n\nETCLOVG layer: ${failureLayer(reason)}\nПричина: ${sanitize(reason)}\n\nПопыток: ${attempts}\n\nPR: ${BRANCH} -> ${BASE_BRANCH}`
  );
  state.tasksBlocked += 1;
  recordTask(task, { attempts, result: "blocked", reason });
  keyMemory(task, "failure", reason, { tags: ["blocked"] });
  log("task.blocked", { task: task.id, message: String(reason).slice(0, 500) });
}

function failureLayer(reason) {
  const detail = String(reason || "").toLowerCase();
  if (/verify|assert|test|review verdict/.test(detail)) return "V";
  if (/context|truncat|token limit/.test(detail)) return "C";
  if (/tool|mcp|permission denied/.test(detail)) return "T";
  if (/policy|protected|secret/.test(detail)) return "G";
  if (/model|quota|rate limit|429|401|provider/.test(detail)) return "O";
  if (/timeout|budget|spawn|process/.test(detail)) return "E";
  return "L";
}

function keyMemory(task, kind, text, extra = {}) {
  if (!task) return;
  try {
    if (kind === "failure") {
      const fingerprint = failureFingerprint(text);
      recordFailure({
        task: task.id,
        area: task.area,
        phase: extra.phase || "task",
        reason: text,
        model: state.activeModel,
        tags: extra.tags || [],
        fingerprint
      });
      const trend = repeatedFailureTrend(loadMemory(), fingerprint);
      if (trend.repeated) createImprovementProposal(fingerprint, trend);
    } else {
      recordLesson({
        task: task.id,
        area: task.area,
        phase: extra.phase || "task",
        text,
        model: state.activeModel,
        tags: extra.tags || []
      });
    }
  } catch {
    log("memory.write.error", { message: "could not persist harness observation" });
  }
}

/**
 * Проверки после реализации. Возвращает {ok, verify, taskVerify, ui, changed}.
 * Ничего не откатывает: решение принимает runTask.
 */
async function evaluateWork(task, { includeUi = true } = {}) {
  const changed = changedForCommit();
  if (changed.length === 0) {
    return { ok: false, changed, verify: null, taskVerify: null, ui: null, reason: "no changes after DONE" };
  }

  const guard = guardDiff(changed);
  if (guard.length > 0) {
    return { ok: false, changed, verify: null, taskVerify: null, ui: null, reason: guard.join("; ") };
  }

  const verify = runVerify(task.id);
  const taskVerify = runTaskVerify(task);
  const ui = includeUi ? await runUiCheck(task) : { ok: true, skipped: true, reason: "disabled" };

  if (!verify.ok || !taskVerify.ok || !ui.ok) {
    return { ok: false, changed, verify, taskVerify, ui, reason: verifyFailures(verify, taskVerify) || uiFailures(ui) };
  }
  return { ok: true, changed, verify, taskVerify, ui, reason: "" };
}

async function attemptTask(task, attempt) {
  const started = Date.now();
  state.correlationId = randomUUID();
  writeQueue(markClaimed(readQueueText(), task.id, { attempts: attempt }));
  log("task.start", { task: task.id, message: `attempt ${attempt}/${LIMITS.maxAttempts}` });
  persistState("claim", { attempt });

  const context = buildContext({
    task,
    phase: "implement",
    maxChars: LIMITS.contextChars,
    memory: searchMemory(`${task.title} ${task.acceptance} ${task.area}`, {
      task: task.id,
      area: task.area,
      limit: LIMITS.memoryEntries
    })
  });
  writeArtifact(`context-${task.id}-${attempt}.md`, context.text);

  let plan = state.plan;
  let previousFailure = "";

  // План и goldfish review плана: read-only, свежий контекст у reviewer.
  if (PHASES.plan && !cli.noPlan && !plan) {
    for (let planRound = 0; planRound <= LIMITS.maxPlanRepairs; planRound += 1) {
      const planned = planRound === 0
        ? await phasePlan({ task, context, memory: searchMemory(task.title, { task: task.id, limit: 4 }), attempt })
        : await phasePlanRepair({ task, context, plan, findings: state.specFindings || "", attempt });

      if (planned.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: planned.reason, metrics: planned.metrics, model: planned.model, durationMs: Date.now() - started };
      }
      if (planned.kind !== "ok") {
        git.revertWorktree();
        return { kind: ["exhausted", "budget"].includes(planned.kind) ? planned.kind : "attempt", reason: planned.reason, metrics: planned.metrics, model: planned.model, durationMs: Date.now() - started };
      }

      plan = planned.text;
      state.plan = plan;
      if (!PHASES.specReview) break;

      const review = await phaseSpecReview({ task, context, plan, attempt });
      if (review.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: review.reason, metrics: review.metrics, model: review.model, durationMs: Date.now() - started };
      }
      if (review.kind === "exhausted" || review.kind === "infra" || review.kind === "budget") {
        git.revertWorktree();
        return { kind: review.kind, reason: review.reason, metrics: review.metrics, model: review.model, durationMs: Date.now() - started };
      }
      if (review.verdict === "PASS") break;
      state.specFindings = review.text;
      writeArtifact(`spec-findings-${task.id}-${planRound}.md`, review.text);
      previousFailure = `План не прошёл goldfish review: ${review.text.slice(-3000)}`;
      if (planRound >= LIMITS.maxPlanRepairs) {
        git.revertWorktree();
        return {
          kind: "attempt",
          reason: `plan review failed: ${review.text.slice(-800)}`,
          metrics: review.metrics,
          model: review.model,
          durationMs: Date.now() - started
        };
      }
    }
  }

  // Реализация и локальная починка.
  let implemented = false;
  let lastEvaluation = null;

  for (let round = 0; round <= LIMITS.maxRepairs; round += 1) {
    if (round === 0) {
      const result = await phaseImplement({
        task,
        context,
        plan,
        memory: searchMemory(`${task.title} ${task.area}`, { task: task.id, limit: 4 }),
        attempt,
        previousFailure
      });
      if (result.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: result.reason, metrics: result.metrics, model: result.model, durationMs: Date.now() - started };
      }
      if (result.kind !== "ok") {
        git.revertWorktree();
        return {
          kind: ["exhausted", "budget"].includes(result.kind) ? result.kind : "attempt",
          reason: result.reason,
          metrics: result.metrics,
          model: result.model,
          durationMs: Date.now() - started
        };
      }
      implemented = true;
    } else {
      const result = await phaseRepair({
        task,
        context,
        plan,
        verify: lastEvaluation?.verify,
        ui: lastEvaluation?.ui,
        attempt,
        round
      });
      if (result.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: result.reason, metrics: result.metrics, model: result.model, durationMs: Date.now() - started };
      }
      if (result.kind !== "ok") {
        git.revertWorktree();
        return {
          kind: ["exhausted", "budget"].includes(result.kind) ? result.kind : "attempt",
          reason: result.reason,
          metrics: result.metrics,
          model: result.model,
          durationMs: Date.now() - started
        };
      }
    }

    lastEvaluation = await evaluateWork(task);
    state.verify = lastEvaluation.verify;
    state.ui = lastEvaluation.ui;
    writeArtifact(`verify-${task.id}-${attempt}-${round}.json`, {
      ok: lastEvaluation.ok,
      verify: lastEvaluation.verify,
      taskVerify: lastEvaluation.taskVerify,
      ui: lastEvaluation.ui
    });

    if (lastEvaluation.ok) break;
    log("verify.fail", {
      task: task.id,
      phase: "verify",
      message: sanitize(lastEvaluation.reason).slice(0, 700)
    });
    if (round >= LIMITS.maxRepairs) break;
  }

  if (!lastEvaluation?.ok) {
    git.revertWorktree();
    return {
      kind: "attempt",
      reason: lastEvaluation?.reason || "verification failed",
      metrics: { tokenTotal: 0 },
      model: state.activeModel,
      changed: lastEvaluation?.changed || [],
      durationMs: Date.now() - started
    };
  }

  // Независимый review. Reviewer получает свежий контекст и другой провайдер,
  // если он есть. FAIL возвращает задачу в repair, а не сразу в блокировку.
  let reviewApproved = !PHASES.review || cli.noReview;
  if (!reviewApproved) {
    for (let reviewRound = 0; reviewRound < LIMITS.maxAttempts; reviewRound += 1) {
      const review = await phaseReview({ task, context, plan, verify: lastEvaluation.verify, ui: lastEvaluation.ui, attempt, round: reviewRound + 1 });
      if (review.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: review.reason, metrics: review.metrics, model: review.model, durationMs: Date.now() - started };
      }
      if (review.kind === "exhausted" || review.kind === "infra" || review.kind === "budget") {
        git.revertWorktree();
        return { kind: review.kind, reason: review.reason, metrics: review.metrics, model: review.model, durationMs: Date.now() - started };
      }
      if (review.verdict === "PASS") {
        reviewApproved = true;
        break;
      }

      state.reviewFindings = review.text;
      writeArtifact(`review-${task.id}-${reviewRound + 1}.md`, review.text);
      const repaired = await phaseRepair({
        task,
        context,
        plan,
        verify: lastEvaluation.verify,
        ui: lastEvaluation.ui,
        attempt,
        round: LIMITS.maxRepairs + reviewRound + 1
      });
      if (repaired.kind === "blocked") {
        git.revertWorktree();
        return { kind: "blocked", reason: repaired.reason, metrics: repaired.metrics, model: repaired.model, durationMs: Date.now() - started };
      }
      if (repaired.kind !== "ok") {
        git.revertWorktree();
        return {
          kind: ["exhausted", "budget"].includes(repaired.kind) ? repaired.kind : "attempt",
          reason: repaired.reason || review.reason,
          metrics: repaired.metrics,
          model: repaired.model,
          durationMs: Date.now() - started
        };
      }
      lastEvaluation = await evaluateWork(task);
      state.verify = lastEvaluation.verify;
      state.ui = lastEvaluation.ui;
      if (!lastEvaluation.ok) {
        git.revertWorktree();
        return {
          kind: "attempt",
          reason: lastEvaluation.reason,
          metrics: { tokenTotal: 0 },
          model: state.activeModel,
          changed: lastEvaluation.changed,
          durationMs: Date.now() - started
        };
      }
    }
  }

  if (!reviewApproved) {
    git.revertWorktree();
    return {
      kind: "attempt",
      reason: `review failed: ${(state.reviewFindings || "no verdict").slice(-800)}`,
      metrics: { tokenTotal: 0 },
      model: state.activeModel,
      changed: lastEvaluation.changed,
      durationMs: Date.now() - started
    };
  }

  const signal = flags(
    {
      repeatedCalls: { maxRepeat: 0, tools: [] },
      toolCalls: 0,
      toolErrorRate: 0,
      tokenTotal: state.budgetTokenTotal
    },
    { changedFiles: lastEvaluation.changed.length, tokenBudget: LIMITS.tokenBudget }
  );
  return {
    kind: "ok",
    metrics: { tokenTotal: state.tokenTotal },
    changed: lastEvaluation.changed,
    flags: signal,
    model: state.activeModel,
    durationMs: Date.now() - started
  };
}

async function runTask(task, { resumePhase = "" } = {}) {
  state.taskStartedAt = Date.now();
  state.correlationId = randomUUID();
  const attemptsLimit = LIMITS.maxAttempts;
  let lastReason = "attempt limit reached";

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    let outcome;
    try {
      if (resumePhase && attempt === 1 && state.plan) {
        const evaluation = await evaluateWork(task);
        state.verify = evaluation.verify;
        state.ui = evaluation.ui;
        if (evaluation.ok) {
          outcome = { kind: "ok", metrics: { tokenTotal: 0 }, changed: evaluation.changed, flags: [], model: state.activeModel, durationMs: 0 };
        } else {
          const repaired = await phaseRepair({
            task,
            context: buildContext({ task, phase: "repair", maxChars: LIMITS.contextChars }),
            plan: state.plan,
            verify: evaluation.verify,
            ui: evaluation.ui,
            attempt,
            round: 1
          });
          outcome = {
            kind: repaired.kind === "ok" ? "ok" : repaired.kind,
            reason: repaired.reason,
            metrics: repaired.metrics,
            changed: repaired.kind === "ok" ? changedForCommit() : [],
            flags: [],
            model: repaired.model,
            durationMs: repaired.durationMs
          };
        }
      } else {
        outcome = await attemptTask(task, attempt);
      }
    } catch (error) {
      git.revertWorktree();
      log("task.error", { task: task.id, message: `attempt ${attempt}: ${error.message}` });
      outcome = { kind: "attempt", reason: `harness error: ${error.message}`, metrics: { tokenTotal: 0 }, durationMs: 0 };
    }

    if (outcome.kind === "ok") {
      const queueText = readQueueText();
      writeQueue(markDone(queueText, task.id));
      const message = `fa(${task.area || "task"}): ${task.title} (${task.id})`;
      const body = [
        `FA-Task: ${task.id}`,
        `FA-Run: ${state.runId}`,
        `Models: ${[...new Set(state.phases.map((phase) => phase.model).filter(Boolean))].join(", ")}`,
        `Planner: ${state.phases.find((phase) => phase.phase === "plan")?.model || "n/a"}`,
        `Executor: ${state.phases.filter((phase) => phase.phase === "implement").map((phase) => phase.model).join(", ") || "n/a"}`,
        `Reviewer: ${state.phases.filter((phase) => phase.phase === "review").map((phase) => phase.model).join(", ") || "n/a"}`,
        `Prompt: ${PROMPT_VERSION}/${promptVersionsLine()}`,
        `Attempts: ${attempt}`,
        `Repairs: ${state.repairs}`,
        `Model-Fallbacks: ${state.modelFallbacks}`,
        `Files: ${(outcome.changed || []).join(", ")}`,
        `Verify: ${state.verify?.checkCount || 0} checks`,
        `UI: ${uiSummary(state.ui || { skipped: true })}`
      ];
      const sha = git.commitAll(message, body);

      let pushed = false;
      if (!cli.noPush) pushed = pushWithRetry();
      if (!pushed && !cli.noPush) {
        state.infraFailures += 1;
        state.failed = true;
        log("git.push.failed", { task: task.id, message: "commit kept locally, push failed" });
      }

      state.tasksDone += 1;
      recordTask(task, {
        attempts: attempt,
        result: "done",
        files: outcome.changed,
        tokens: state.tokenTotal,
        durationMs: outcome.durationMs,
        model: outcome.model || state.activeModel
      });
      keyMemory(
        task,
        "lesson",
        `Успех: ${outcome.changed.length} файлов, проверки ${state.verify?.checkCount || 0}, UI ${state.ui?.ok ? "PASS" : "skip"}. Решение держать в: ${state.plan.split("\n").slice(0, 3).join(" ").slice(0, 300)}`,
        { tags: ["success"] }
      );
      log("task.done", {
        task: task.id,
        message: `${sha.slice(0, 8)} ${outcome.changed.length} files, ${state.tokenTotal} tokens, model=${outcome.model || state.activeModel}${outcome.flags.length ? `, flags: ${outcome.flags.join(",")}` : ""}`
      });

      clearActive();
      if (pushed) ensurePr();
      return { result: "done", attempts: attempt };
    }

    if (outcome.kind === "budget") {
      git.revertWorktree();
      state.stopReason = /token budget/i.test(outcome.reason || "")
        ? "token budget exhausted"
        : Date.now() - state.taskStartedAt >= LIMITS.taskTimeoutMs
          ? "task time budget exhausted"
          : "run time budget exhausted";
      log("task.budget_exhausted", { task: task.id, message: sanitize(outcome.reason).slice(0, 400) });
      clearActive();
      return { result: "budget", attempts: attempt };
    }

    if (outcome.kind === "models_exhausted" || outcome.kind === "exhausted") {
      git.revertWorktree();
      const quota = /quota|rate|limit|429/i.test(outcome.reason || "");
      const result = quota ? "quota" : "unavailable";
      state.failed = true;
      state.stopReason = quota ? "provider quota" : "provider unavailable";
      log("task.models_exhausted", {
        task: task.id,
        message: `${state.stopReason}: ${sanitize(outcome.reason).slice(0, 300)}`
      });
      recordTask(task, {
        attempts: attempt,
        result,
        tokens: outcome.metrics.tokenTotal,
        durationMs: outcome.durationMs,
        model: outcome.model,
        reason: outcome.reason
      });
      keyMemory(task, "failure", `${state.stopReason}: ${outcome.reason}`, { phase: "model", tags: ["transient"] });
      clearActive();
      return { result, attempts: attempt };
    }

    if (outcome.kind === "infra") {
      git.revertWorktree();
      state.infraFailures += 1;
      if (state.infraFailures >= LIMITS.maxInfraFailures || attempt >= attemptsLimit) {
        state.failed = true;
        state.stopReason = "infrastructure failures";
        if (state.infraFailures >= LIMITS.maxInfraFailures) {
          createIssue(
            "FA infrastructure failure",
            `Подряд инфра-провалов: ${state.infraFailures}.\n\nПоследняя причина: ${outcome.reason}\n\nЗадача: ${task.id}`
          );
        }
        clearActive();
        return { result: "infra", attempts: attempt };
      }
      log("task.retry", { task: task.id, message: `infra, attempt ${attempt}` });
      continue;
    }

    if (outcome.kind === "blocked") {
      git.revertWorktree();
      blockTask(task, outcome.reason, attempt);
      clearActive();
      return { result: "blocked", attempts: attempt };
    }

    git.revertWorktree();
    state.infraFailures = 0;
    lastReason = outcome.reason || "attempt failed";
    keyMemory(task, "failure", lastReason, { phase: "attempt", tags: ["attempt"] });
    log("task.retry", { task: task.id, message: `attempt ${attempt}: ${sanitize(outcome.reason).slice(0, 300)}` });

    if (attempt < attemptsLimit) {
      state.plan = "";
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  blockTask(task, lastReason, attemptsLimit);
  clearActive();
  return { result: "blocked", attempts: attemptsLimit };
}

/** Восстановление после убитого процесса или падения job. */
async function tryResume(task) {
  if (cli.noResume) return null;
  const active = loadActive();
  if (!active || !active.runId) return null;
  if (task && active.taskId && active.taskId !== task.id) {
    clearActive();
    return null;
  }
  const saved = findTask(readQueue(), active.taskId);
  const check = canResume(active, {
    task: saved,
    headSha: git.headSha(),
    baseSha: git.headSha()
  });
  if (!check.ok) {
    log("resume.skip", { message: check.reason });
    clearActive();
    return null;
  }

  state.runId = active.runId;
  state.taskId = active.taskId;
  state.models = active.models || state.models;
  state.modelsUsed = active.models || [];
  run = runPaths(active.runId);
  log("resume.start", { task: active.taskId, message: `${check.reason}, models=${state.models.length}` });

  const codePhase = ["implement", "repair", "verify", "review", "commit"].includes(active.phase);
  if (!codePhase) {
    // План мог быть готов, но реализация не начиналась: проходим фазы заново.
    clearActive();
    return { id: saved?.id || "", phase: active.phase, code: false };
  }

  const planFile = active.artifacts?.plan;
  if (planFile && existsSync(planFile)) {
    try {
      state.plan = readFileSync(planFile, "utf8");
    } catch {
      state.plan = "";
    }
  }
  const applied = applyCheckpoint(active.runId);
  if (!applied.ok) {
    log("resume.checkpoint.failed", { message: applied.reason });
    clearActive();
    return { id: saved?.id || "", phase: active.phase, code: false };
  }
  return { id: saved?.id || "", phase: active.phase, code: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  cli = options;

  if (options.help) {
    console.log("usage: node scripts/fa/loop.mjs [--once] [--task Txx] [--dry-run] [--preflight] [--no-push] [--force-local] [--no-ui] [--no-plan] [--no-review] [--no-resume]");
    return;
  }

  const probe = await probeModels();
  const pre = await preflight({ probe, requireUi: process.env.FA_UI_REQUIRED === "true" });
  if (options.preflight) {
    if (pre.ok) console.log("preflight: OK");
    else {
      for (const problem of pre.problems) console.error(`FAIL: ${problem}`);
      console.error("preflight: FAILED");
    }
    for (const warning of pre.warnings) console.warn(`warn: ${warning}`);
    process.exitCode = pre.ok ? 0 : 2;
    return;
  }
  if (pre.problems.length > 0) {
    for (const problem of pre.problems) console.error(`FAIL: ${problem}`);
    for (const warning of pre.warnings) console.warn(`warn: ${warning}`);
    process.exitCode = 2;
    return;
  }

  if (!isCi() && !options.forceLocal) {
    console.error("FA refuses to run outside CI without --force-local (it commits and pushes)");
    process.exitCode = 2;
    return;
  }

  requireCleanWorktree();

  state.models = isCi() ? modelChain().filter((model) => model.available) : modelChain();
  state.session = new ModelSession({ probeIds: probe.ids || [] });
  if (process.env.FA_RESET_AUTH_BREAKERS === "true") {
    state.session.breaker.resetCategory("auth");
    log("model.breakers.reset", { message: "cleared cached auth failures for manual workflow dispatch" });
  }
  state.runId = makeRunId();
  run = runPaths(state.runId);
  log("run.start", {
    message: `${state.runId} models=${state.models.map((model) => model.id).join(" -> ") || "none"} branch=${BRANCH}`
  });

  const stop = killSwitch();
  if (stop) {
    state.stopReason = stop;
    await finish();
    return;
  }

  if (options.dryRun) {
    const tasks = readQueue();
    const task = options.task ? findTask(tasks, options.task) : selectNext(tasks);
    if (!task) {
      console.log("no runnable tasks");
      state.stopReason = "no tasks";
      await finish();
      return;
    }
    const context = buildContext({ task, maxChars: LIMITS.contextChars });
    console.log(`models: ${state.models.map((model) => model.id).join(" -> ") || "none"}`);
    console.log(`roles: ${JSON.stringify(Object.fromEntries(["planner", "executor", "repair", "reviewer"].map((role) => [role, state.session.candidates(role).map((model) => model.id)])))}`);
    console.log(`context: ${context.chars} chars, files: ${context.files.join(", ")}`);
    console.log(buildPlanPrompt({ task, context: context.text }));
    state.stopReason = "dry run";
    await finish();
    return;
  }

  if (state.models.length === 0) {
    state.failed = true;
    state.stopReason = "no model with provider key";
    log("models.missing", { message: "set provider keys or FA_MODELS" });
    await finish();
    return;
  }

  try {
    const pr = prState();
    if (pr?.state === "MERGED") {
      log("branch.reset", { message: `PR #${pr.number} merged; reset ${BRANCH} to ${BASE_BRANCH}` });
      git.fetchOrigin();
      git.resetToBase(BRANCH, BASE_BRANCH);
      const removed = git.git(["push", "origin", "--delete", BRANCH], { allowFailure: true });
      log("branch.cleanup", {
        message: removed.code === 0 ? `remote ${BRANCH} deleted` : `remote ${BRANCH} not deleted (${removed.stderr.slice(0, 200)})`
      });
    } else if (pr?.state === "CLOSED") {
      log("branch.reset", { message: `PR #${pr.number} closed; reset ${BRANCH} to ${BASE_BRANCH}` });
      git.fetchOrigin();
      git.resetToBase(BRANCH, BASE_BRANCH);
      const removed = git.git(["push", "origin", "--delete", BRANCH], { allowFailure: true });
      log("branch.cleanup", {
        message: removed.code === 0 ? `remote ${BRANCH} deleted` : `remote ${BRANCH} not deleted (${removed.stderr.slice(0, 200)})`
      });
    }

    const branch = git.ensureWorkBranch(BRANCH, BASE_BRANCH);
    log("branch.ready", { message: `${branch.branch}${branch.created ? " (created)" : ""}` });
  } catch (error) {
    state.failed = true;
    state.stopReason = "branch setup failed";
    log("branch.error", { message: error.message });
    createIssue("FA infrastructure failure", `Не удалось подготовить ветку ${BRANCH}.\n\n${error.message}`);
    await finish();
    return;
  }

  try {
    const queueText = readQueueText();
    const claimsReset = resetStaleClaims(queueText);
    const recovered = resetQuotaBlocks(claimsReset);
    if (recovered !== queueText) {
      writeQueue(recovered);
      const sha = git.commitAll("chore(fa): recover queue", [
        "FA: stale [~] and quota [!] reset to [ ]",
        "Quota is transient; the task must be retried on the next run."
      ]);
      if (!cli.noPush) pushWithRetry();
      log("queue.recover", { message: `queue recovered (${sha.slice(0, 8)})` });
    }
  } catch (error) {
    log("queue.recover.error", { message: error.message });
  }

  let tasks = readQueue();
  let task = options.task ? findTask(tasks, options.task) : selectNext(tasks);
  const resumed = await tryResume(task);
  if (resumed?.id) {
    tasks = readQueue();
    task = findTask(tasks, resumed.id);
    if (!task) {
      clearActive();
      state.stopReason = `resume task ${resumed.id} is missing`;
      await finish();
      return;
    }
    if (task.status === "claimed") {
      // claim мог остаться от прерванного процесса; возвращаем в работу
      writeQueue(markClaimed(readQueueText(), task.id, {}));
    }
    const outcome = await runTask(task, { resumePhase: resumed.code ? "resume" : "" });
    state.stopReason = outcome.result === "budget" ? state.stopReason : `task ${task.id} ${outcome.result}`;
    await finish();
    return;
  }

  if (!task) {
    state.stopReason = options.task ? `task ${options.task} is not runnable` : "no tasks";
    if (options.task) state.failed = true;
    await finish();
    return;
  }

  if (task.status !== "todo") {
    state.stopReason = `task ${task.id} is ${task.status}`;
    state.failed = true;
    await finish();
    return;
  }

  if (budgetExhausted(state.startedAt)) {
    state.stopReason = "run budget exhausted";
    await finish();
    return;
  }

  state.taskId = task.id;
  const outcome = await runTask(task);
  state.stopReason = outcome.result === "budget" ? state.stopReason : `task ${task.id} ${outcome.result}`;
  await finish();
}

async function finish() {
  const durationMs = Date.now() - state.startedAt;
  const costTotal = state.phases.reduce((sum, phase) => sum + (Number(phase.cost) || 0), 0);
  const priorCosts = [];
  if (existsSync(PATHS.logs)) {
    const dirs = readdirSync(PATHS.logs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== run?.dir.split("/").pop())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, 30);
    for (const dir of dirs) {
      const file = join(PATHS.logs, dir, "summary.json");
      if (!existsSync(file)) continue;
      try {
        const previous = JSON.parse(readFileSync(file, "utf8"));
        if (Number.isFinite(previous.cost?.total) && previous.cost.total > 0) priorCosts.push(previous.cost.total);
      } catch (error) {
        log("cost.history.read_error", { message: `${dir}: ${error.message}` });
      }
    }
  }
  priorCosts.sort((left, right) => left - right);
  const middle = Math.floor(priorCosts.length / 2);
  const medianCost = priorCosts.length
    ? priorCosts.length % 2
      ? priorCosts[middle]
      : (priorCosts[middle - 1] + priorCosts[middle]) / 2
    : 0;
  const costAnomaly = medianCost > 0 && costTotal > medianCost * 2;
  if (costAnomaly) {
    console.warn(`cost anomaly: run cost ${costTotal.toFixed(6)} USD is over 2x median ${medianCost.toFixed(6)} USD`);
    log("cost.anomaly", { currentCost: costTotal, medianCost, thresholdMultiplier: 2 });
  }
  const summary = {
    runId: run ? run.dir.split("/").pop() : makeRunId(),
    ok: isSuccessfulRun(state),
    stopReason: state.stopReason,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: nowIso(),
    durationMs,
    model: state.activeModel || state.models[0]?.id || "",
    models: state.models.map((model) => model.id),
    modelFallbacks: state.modelFallbacks,
    prompt: PROMPT_VERSION,
    promptVersions: PROMPT_VERSIONS,
    roles: state.session?.snapshot ? state.session.snapshot() : null,
    tasksDone: state.tasksDone,
    tasksBlocked: state.tasksBlocked,
    tokens: { total: state.tokenTotal, budgeted: state.budgetTokenTotal, limit: LIMITS.tokenBudget },
    cost: { total: Number(costTotal.toFixed(6)), median: Number(medianCost.toFixed(6)), anomaly: costAnomaly },
    phases: state.phases,
    verify: state.verify ? { ok: state.verify.ok, checks: state.verify.checkCount } : null,
    ui: state.ui ? { ok: state.ui.ok, skipped: state.ui.skipped, checks: state.ui.checks?.length || 0 } : null,
    tasks: state.tasks
  };

  if (run) {
    writeFileSync(run.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });
    writeFileSync(join(PATHS.logs, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    try {
      const tasks = readQueue();
      writeFileSync(run.status, statusMarkdown(tasks, summary), "utf8");
    } catch {
      // статус — вспомогательный артефакт
    }
  }

  log("run.finish", {
    message: `${summary.ok ? "ok" : "failed"} (${summary.stopReason}), done=${summary.tasksDone}, blocked=${summary.tasksBlocked}, tokens=${state.tokenTotal}`
  });

  await flushTelemetry({ runDir: run?.dir || "" });
  process.exitCode = isSuccessfulRun(state) ? 0 : 1;
}

main().catch(async (error) => {
  state.failed = true;
  state.stopReason = "fatal error";
  try {
    log("run.fatal", { message: error.stack || error.message });
  } catch {
    console.error(error);
  }
  await finish();
});
