#!/usr/bin/env node
// Self-test harness-модулей без сети, модели и браузера. Быстрый и бесплатный.
// Проверяет контракты, на которых держится оркестратор.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, classifyFailure, estimateTokens, parseModels, providerOf, roleSummary } from "./models.mjs";
import { Breaker, ModelSession, RateLedger, roleCandidates } from "./router.mjs";
import { buildContext, expandFiles } from "./context.mjs";
import { addMemory, failureFingerprint, loadMemory, repeatedFailureTrend, searchMemory } from "./memory.mjs";
import { createRunState, loadRunState, saveRunState, setPhase } from "./state.mjs";
import { readQueue } from "./queue.mjs";
import { validatePrompts } from "./prompts.mjs";
import { TOOLS } from "./mcp-server.mjs";
import { findChrome } from "./ui.mjs";
import { LIMITS, ROOT, phaseTimeout } from "./config.mjs";

const checks = [];
const errors = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, status: "ok", detail: detail || "" });
  } catch (error) {
    checks.push({ name, status: "fail", detail: error.message });
    errors.push(`${name}: ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, status: "ok", detail: detail || "" });
  } catch (error) {
    checks.push({ name, status: "fail", detail: error.message });
    errors.push(`${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

check("models.classify", () => {
  assert(classifyFailure("429 Too Many Requests") === "quota", "429 is not quota");
  assert(classifyFailure("401 Unauthorized") === "auth", "401 is not auth");
  assert(classifyFailure("provider.invalid-request: model reached end of life and is no longer available (410)") === "unavailable", "retired model is not classified for fallback");
  assert(classifyFailure("context_length_exceeded") === "context", "context is not classified");
  assert(classifyFailure("VERDICT: FAIL") === "other", "verdict is not a model failure");
  assert(estimateTokens(4000) === 1000, "estimateTokens is wrong");
  assert(providerOf("google/gemini-3.1-flash-lite") === "google", "providerOf is wrong");
  assert(parseModels("custom/model-v1")[0].provider === "custom", "custom provider parsing failed");
});

check("models.defaults", () => {
  const ids = DEFAULT_MODELS.map((model) => model.id);
  assert(ids.some((id) => id.startsWith("google/")), "Gemini is missing from defaults");
  assert(ids.includes("xerosharc/claude-haiku-5-5"), "XEROSHARC Haiku is missing from defaults");
  assert(ids.includes("xerosharc/claude-sonnet-5-5"), "XEROSHARC Sonnet is missing from defaults");
  assert(ids.includes("openrouter/baidu/ernie-5.5-flash-preview:free"), "OpenRouter ERNIE is missing from defaults");
  assert(ids.includes("nvidia/nemotron-3-ultra-550b-a55b"), "active NVIDIA Nemotron model is missing from defaults");
  assert(!ids.some((id) => id.includes("deepseek-v4.1-flash")), "retired NVIDIA DeepSeek model remains enabled");
  const opencodeConfig = readFileSync(join(ROOT, "opencode.jsonc"), "utf8");
  assert(opencodeConfig.includes('"modelID": "nvidia/nemotron-3-ultra-550b-a55b"'), "NVIDIA provider does not send its required API model ID");
  assert(DEFAULT_MODELS.find((model) => model.id === "openrouter/baidu/ernie-5.5-flash-preview:free")?.dailyLimit === 2, "OpenRouter ERNIE daily limit must default to two calls");
  assert(!ids.some((id) => id.startsWith("opencode/") || id.startsWith("anthropic/")), "unconfigured free/direct provider remains in defaults");
  assert(!ids.some((id) => id.includes("deepseek-v4.1-flash-free")), "unverified OpenCode DeepSeek free model remains enabled");
});

check("models.scarce-profile", () => {
  const agent = readFileSync(join(ROOT, ".opencode/agents/fa-scarce.md"), "utf8");
  const runner = readFileSync(join(ROOT, "scripts/fa/runner.mjs"), "utf8");
  assert(/^steps: 1$/m.test(agent), "scarce-model profile is not limited to one turn");
  assert(agent.includes('effect: deny'), "scarce-model profile does not deny tools");
  assert(runner.includes('model.dailyLimit ? "fa-scarce" : agent'), "runner does not select the scarce-model profile");
});

check("execution.deadline", () => {
  const expiredAt = Date.now() - LIMITS.runBudgetMs - 1;
  assert(phaseTimeout(expiredAt, 30_000) === 0, "phase timeout exceeded the run deadline");
});

check("models.roles", () => {
  const roles = roleSummary({
    ...process.env,
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    GEMINI_API_KEY: "test-key",
    XEROSHARC_API_KEY: "test-key"
  });
  for (const role of ["planner", "executor", "repair", "reviewer"]) {
    assert(Array.isArray(roles[role]) && roles[role].length > 0, `${role} has no models`);
  }
  assert(roleCandidates("reviewer", {
    env: { ...process.env, FA_AVAILABLE_MODELS: "", GEMINI_API_KEY: "test-key", XEROSHARC_API_KEY: "test-key" }
  }).length > 0, "no reviewer candidates");
});

check("router.ledger", () => {
  let now = 1_000_000;
  const ledger = new RateLedger({ now: () => now });
  const model = { id: "test/model", provider: "test", tpm: 1000 };
  ledger.record(model, 800);
  assert(ledger.waitMs(model, 100) === 0, "rate wait should be zero");
  assert(ledger.waitMs(model, 500) > 0, "rate wait should be positive");
  now += 61_000;
  assert(ledger.waitMs(model, 500) === 0, "rate window did not expire");
});

await checkAsync("router.daily-cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-daily-calls-"));
  let now = Date.UTC(2026, 10, 20, 12);
  const modelId = "openrouter/baidu/ernie-5.5-flash-preview:free";
  const env = {
    ...process.env,
    FA_MODELS: modelId,
    FA_OPENROUTER_ERNIE_DAILY_LIMIT: "2",
    FA_ROUTER_STATE_DIR: join(dir, "state"),
    OPENROUTER_API_KEY: "test-openrouter-key"
  };
  try {
    const options = { env, root: dir, now: () => now, tokenBudget: 10_000 };
    const session = new ModelSession(options);
    for (let call = 0; call < 2; call += 1) {
      const reservation = await session.reserve("planner", { estimateTokens: 100, maxWaitMs: 0 });
      assert(reservation.ok && reservation.model.id === modelId, `daily model call ${call + 1} was not reserved`);
      session.settle(reservation.reservation, { actualTokens: 100 });
    }
    const restored = new ModelSession(options);
    const capped = await restored.reserve("planner", { estimateTokens: 100, maxWaitMs: 0 });
    assert(!capped.ok, "daily limit allowed a third request");
    assert(restored.dailyCalls.used({ id: modelId }, now) === 2, "daily request count did not persist");
    now += 86_400_000;
    const nextDay = await restored.reserve("planner", { estimateTokens: 100, maxWaitMs: 0 });
    assert(nextDay.ok, "daily request limit did not reset on the next UTC day");
    const disabled = new ModelSession({
      ...options,
      env: { ...env, FA_OPENROUTER_ERNIE_DAILY_LIMIT: "0", FA_ROUTER_STATE_DIR: join(dir, "disabled") }
    });
    assert(!(await disabled.reserve("planner", { estimateTokens: 100, maxWaitMs: 0 })).ok, "zero daily limit did not disable the model");
    const invalid = new ModelSession({
      ...options,
      env: { ...env, FA_OPENROUTER_ERNIE_DAILY_LIMIT: "two", FA_ROUTER_STATE_DIR: join(dir, "invalid") }
    });
    let invalidLimitError = "";
    try {
      await invalid.reserve("planner", { estimateTokens: 100, maxWaitMs: 0 });
    } catch (error) {
      invalidLimitError = error.message;
    }
    assert(invalidLimitError.includes("must be a non-negative integer"), "invalid daily limit was not reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("router.breaker", () => {
  const breaker = new Breaker({ cooldownMs: 1000, now: () => 1_000_000 });
  breaker.trip("test/model", "quota", "429");
  assert(breaker.isOpen("test/model"), "breaker did not open");
  const snapshot = breaker.snapshot();
  assert(snapshot["test/model"], "breaker snapshot is empty");
  breaker.reset("test/model");
  assert(!breaker.isOpen("test/model"), "breaker did not reset");
  breaker.trip("test/auth", "auth", "old credential failure");
  breaker.trip("test/quota", "quota", "rate limit");
  breaker.resetCategory("auth");
  assert(!breaker.isOpen("test/auth"), "auth breakers were not cleared for manual retry");
  assert(breaker.isOpen("test/quota"), "clearing auth breakers also cleared a quota breaker");
});

check("prompts.contract", () => {
  const problems = validatePrompts();
  assert(problems.length === 0, problems.join("; "));
});

check("context.build", () => {
  const task = readQueue()[0];
  assert(task, "queue is empty");
  const pack = buildContext({ task, maxChars: 12_000 });
  assert(pack.text.includes("Acceptance"), "acceptance is missing");
  assert(pack.chars > 0 && pack.tokens > 0, "context is empty");
  assert(pack.chars === pack.text.length, "context.chars does not match text");
  assert(pack.text.length <= 12_000, `context exceeds its budget: ${pack.text.length}`);
  assert(pack.truncated === true, "context must report truncation at a tight budget");
});

check("context.project-rules", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-context-"));
  const outside = mkdtempSync(join(tmpdir(), "fa-context-outside-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(outside, "secret.js"), "export const secret = true;", "utf8");
    symlinkSync(join(outside, "secret.js"), join(root, "src", "external.js"));
    writeFileSync(join(root, "AGENTS.md"), "root agent rules", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "root Claude rules", "utf8");
    writeFileSync(join(root, "src", "AGENTS.md"), "nested agent rules", "utf8");
    writeFileSync(join(root, "src", "app.js"), "export const app = true;", "utf8");
    const task = { id: "T00", title: "Context fixture", area: "code", files: ["src/app.js"], context: [] };
    const pack = buildContext({ root, task, maxChars: 12_000 });
    for (const rule of ["root agent rules", "root Claude rules", "nested agent rules"]) {
      assert(pack.text.includes(rule), `missing applicable rule: ${rule}`);
    }
    assert(!pack.ui, "non-UI task was classified as a UI task");
    assert(buildContext({ root, task: { ...task, fields: { ui: "click list" } }, maxChars: 12_000 }).ui, "task UI scenario was not recognized");
    assert(expandFiles(root, ["../../outside.txt"]).length === 0, "context accepted a path outside the repository");
    assert(expandFiles(root, ["src/external.js"]).length === 0, "context followed a symlink outside the repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await checkAsync("router.token-budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "fa-router-"));
  try {
    const session = new ModelSession({
      root,
      tokenBudget: 50,
      env: {
        ...process.env,
        FA_MODELS: "google/gemini-3.1-flash-lite",
        FA_AVAILABLE_MODELS: "",
        FA_EXCLUDE_MODELS: "",
        FA_ROUTER_STATE_DIR: join(root, "state"),
        GEMINI_API_KEY: "test-key-one",
        GEMINI_API_KEY_2: "test-key-two"
      }
    });
    const first = await session.reserve("planner", { estimateTokens: 40, maxWaitMs: 0 });
    assert(first.ok, "first reservation unexpectedly failed");
    session.settle(first.reservation, { actualTokens: 45 });
    const second = await session.reserve("planner", { estimateTokens: 10, maxWaitMs: 0 });
    assert(!second.ok && second.budgetExhausted, "token budget was not enforced before the next call");
    assert(session.snapshot().tokens.used === 45, "actual token usage was not recorded");
    const model = parseModels("google/gemini-3.1-flash-lite")[0];
    assert(session.providerEnv(model).GEMINI_API_KEY === "test-key-one", "primary Gemini key was not selected");
    assert(session.rotateCredential(model), "second Gemini key was not available for quota fallback");
    assert(session.providerEnv(model).GEMINI_API_KEY === "test-key-two", "Gemini key rotation did not select the next key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("memory.roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-memory-"));
  const file = join(dir, "entries.jsonl");
  try {
    const fingerprint = failureFingerprint("T00 verification failed at line 42");
    for (const [task, at] of [["T01", "2026-11-18T00:00:00.000Z"], ["T02", "2026-11-19T00:00:00.000Z"], ["T03", "2026-11-20T00:00:00.000Z"]]) {
      addMemory({
        task,
        area: "test",
        phase: "verify",
        kind: "failure",
        fingerprint,
        text: "verification failed",
        at
      }, { file });
    }
    addMemory({ task: "T00", area: "test", kind: "lesson", text: "список закрывается по Escape" }, { file });
    const entries = loadMemory({ file });
    assert(entries.length === 4, "memory entries were not stored");
    assert(searchMemory("Escape", { file }).length === 1, "memory search did not find the entry");
    const trend = repeatedFailureTrend(entries, fingerprint);
    assert(trend.repeated && trend.tasks.length === 3, "repeated failures were not detected across distinct tasks");
    const old = [{ kind: "failure", fingerprint, task: "T04", at: "2020-01-01T00:00:00.000Z" }];
    assert(!repeatedFailureTrend([...entries, ...old], fingerprint).tasks.includes("T04"), "old failure was not aged out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("state.roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-state-"));
  try {
    const root = dir;
    const created = createRunState({ runId: "test-run", taskId: "T00", branch: "fa/test", baseSha: "abc", root });
    assert(created.phase === "init", "initial phase is wrong");
    const next = setPhase(created, "plan", { attempt: 1 });
    saveRunState(next, { root });
    const loaded = loadRunState("test-run", { root });
    assert(loaded.phase === "plan", "phase was not persisted");
    assert(loaded.taskId === "T00", "task was not persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("state.history-limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-history-"));
  try {
    for (let index = 0; index < 7; index += 1) {
      createRunState({ runId: `run-${index}`, taskId: "T00", root: dir });
    }
    const runs = readdirSync(join(dir, "fa/state/runs"));
    assert(runs.length <= 5, `run history was not pruned: ${runs.length} entries`);
    assert(runs.includes("run-6"), "current run was pruned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("workflow.autonomy-contract", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/fa.yml"), "utf8");
  assert(workflow.includes('cron: "*/30 * * * *"'), "workflow cron is not 30 minutes");
  assert(workflow.includes("actions/cache@v4"), "workflow does not persist runtime state");
  assert(workflow.includes("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}"), "workflow does not expose OpenRouter credentials");
  assert(workflow.includes("fa/state/daily-calls.json"), "workflow does not persist daily model limits");
  assert(workflow.includes("FA_RESET_AUTH_BREAKERS: ${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}"), "manual workflow dispatch does not reset cached auth breakers");
  for (const role of ["planner", "executor", "repair", "reviewer"]) {
    assert(workflow.includes(`${role}_model:`), `workflow dispatch is missing the ${role} model selector`);
    const expression = `github.event.inputs.${role}_model != 'inherit' && github.event.inputs.${role}_model || vars.FA_${role.toUpperCase()}_MODEL`;
    assert(workflow.includes(expression), `workflow does not pass the ${role} model selection through`);
  }
  assert(workflow.includes("nvidia/nemotron-3-ultra-550b-a55b"), "workflow model selectors omit the active NVIDIA model");
  const loop = readFileSync(join(ROOT, "scripts/fa/loop.mjs"), "utf8");
  assert(loop.includes('state.session.breaker.resetCategory("auth")'), "manual workflow dispatch cannot clear cached auth failures");
  assert(loop.includes("state.failed = true;\n      state.stopReason = quota ? \"provider quota\" : \"provider unavailable\";"), "unavailable model chains do not fail the workflow");
  for (const index of [2, 3, 4, 5]) {
    const expression = "${{ secrets.GEMINI_API_KEY_" + index + " }}";
    assert(workflow.includes(`GEMINI_API_KEY_${index}: ${expression}`), `workflow does not expose Gemini key ${index}`);
  }
});

check("mcp.tools", () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const name of ["fa_queue", "fa_task", "fa_verify", "fa_diff", "fa_context", "fa_memory", "fa_status"]) {
    assert(names.includes(name), `missing MCP tool ${name}`);
  }
});

check("ui.chrome", () => {
  const chrome = findChrome();
  return chrome ? chrome : "not found (skip)";
});

const ok = errors.length === 0;
const json = process.argv.includes("--json");
if (json) {
  console.log(JSON.stringify({ ok, checks, errors }, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.status === "ok" ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  for (const error of errors) console.error(`\nFAIL ${error}`);
  console.log(`\nFA selftest: ${ok ? "PASS" : "FAIL"} — ${checks.length} checks, ${errors.length} errors`);
}

process.exitCode = ok ? 0 : 1;

export { checks, errors };
