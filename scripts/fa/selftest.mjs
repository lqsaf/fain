#!/usr/bin/env node
// Self-test harness-модулей без сети, модели и браузера. Быстрый и бесплатный.
// Проверяет контракты, на которых держится оркестратор.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, classifyFailure, estimateTokens, modelsForRole, parseModels, providerOf, roleSummary } from "./models.mjs";
import { Breaker, ModelSession, RateLedger, roleCandidates } from "./router.mjs";
import { buildContext, expandFiles } from "./context.mjs";
import { addMemory, failureFingerprint, loadMemory, repeatedFailureTrend, searchMemory } from "./memory.mjs";
import { createRunState, isSuccessfulRun, loadRunState, saveRunState, setPhase } from "./state.mjs";
import { readQueue } from "./queue.mjs";
import { specReviewVerdict, validatePrompts } from "./prompts.mjs";
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
  assert(ids.includes("nvidia/nemotron-3-ultra-550b-a55b"), "active NVIDIA Nemotron model is missing from defaults");
  assert(DEFAULT_MODELS.every((model) => ["google", "nvidia"].includes(model.provider)), "a disallowed provider remains in defaults");
  assert(!ids.some((id) => id.includes("deepseek-v4.1-flash")), "retired NVIDIA DeepSeek model remains enabled");
  const opencodeConfig = readFileSync(join(ROOT, "opencode.jsonc"), "utf8");
  assert(opencodeConfig.includes('"modelID": "nvidia/nemotron-3-ultra-550b-a55b"'), "NVIDIA provider does not send its required API model ID");
  assert(!opencodeConfig.includes("xerosharc") && !opencodeConfig.includes("openrouter"), "removed providers remain configured");
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
    FA_MODELS: "",
    FA_PLANNER_MODEL: "",
    FA_EXECUTOR_MODEL: "",
    FA_REPAIR_MODEL: "",
    FA_REVIEWER_MODEL: "",
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    FA_ALLOW_OPTIONAL: "",
    GEMINI_API_KEY: "test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    NVIDIA_API_KEY: "test-key"
  });
  for (const role of ["planner", "executor", "repair", "reviewer"]) {
    assert(Array.isArray(roles[role]) && roles[role].length > 0, `${role} has no models`);
  }
  assert(roleCandidates("reviewer", {
    env: {
      ...process.env,
      FA_MODELS: "",
      FA_REVIEWER_MODEL: "",
      FA_AVAILABLE_MODELS: "",
      FA_EXCLUDE_MODELS: "",
      FA_ALLOW_OPTIONAL: "",
      GEMINI_API_KEY: "test-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GOOGLE_API_KEY: "",
      NVIDIA_API_KEY: "test-key"
    }
  }).length > 0, "no reviewer candidates");
  const independent = roleCandidates("reviewer", {
    env: {
      ...process.env,
      FA_AVAILABLE_MODELS: "",
      FA_EXCLUDE_MODELS: "",
      FA_REVIEWER_MODEL: "",
      FA_ALLOW_OPTIONAL: "",
      FA_MODELS: "google/gemini-3.1-flash-lite,nvidia/nemotron-3-ultra-550b-a55b",
      GEMINI_API_KEY: "test-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GOOGLE_API_KEY: "",
      NVIDIA_API_KEY: "test-key"
    },
    exclude: ["google/gemini-3.1-flash-lite"]
  });
  assert(independent.length === 1 && independent[0].id === "nvidia/nemotron-3-ultra-550b-a55b", "review exclusion did not select the independent provider");
});

check("models.executor-default", () => {
  const env = {
    ...process.env,
    FA_MODELS: "",
    FA_EXECUTOR_MODEL: "",
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    FA_ALLOW_OPTIONAL: "",
    GEMINI_API_KEY: "test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    NVIDIA_API_KEY: "test-key"
  };
  const executorIds = modelsForRole("executor", env).map((model) => model.id);
  assert(executorIds[0] === "nvidia/nemotron-3-ultra-550b-a55b", "NVIDIA is not the default executor");
  assert(executorIds[1] === "google/gemini-3.1-flash-lite", "Gemini is missing as executor fallback");
  assert(modelsForRole("repair", env)[0]?.provider === "nvidia", "NVIDIA is not the default repair model");
  assert(modelsForRole("planner", env)[0]?.provider === "google", "Gemini is not the default planner");
  assert(modelsForRole("reviewer", env)[0]?.provider === "google", "Gemini is not the default reviewer");
  const legacy = modelsForRole("executor", {
    ...env,
    FA_MODELS: "xerosharc/claude-sonnet-5-5,openrouter/baidu/ernie-5.5-flash-preview:free"
  });
  assert(legacy.map((model) => model.id).join(",") === executorIds.join(","), "legacy provider settings did not fall back to allowed defaults");
  const staleProbe = modelsForRole("executor", {
    ...env,
    FA_MODELS: "",
    FA_AVAILABLE_MODELS: "xerosharc/claude-sonnet-5-5"
  });
  assert(staleProbe.map((model) => model.id).join(",") === executorIds.join(","), "stale provider probe blocked allowed defaults");
  const legacyOverride = modelsForRole("executor", {
    ...env,
    FA_EXECUTOR_MODEL: "xerosharc/claude-sonnet-5-5"
  });
  assert(legacyOverride.map((model) => model.id).join(",") === executorIds.join(","), "legacy executor override blocked allowed defaults");
  const geminiOnly = modelsForRole("executor", { ...env, NVIDIA_API_KEY: "", NVIDIA_NIM_API_KEY: "" });
  assert(geminiOnly.length === 1 && geminiOnly[0].id === "google/gemini-3.1-flash-lite", "Gemini was not used when NVIDIA is unavailable");
});

check("state.blocked-run-fails", () => {
  assert(!isSuccessfulRun({ failed: false, tasksBlocked: 1 }), "a blocked task produced a successful run");
  assert(!isSuccessfulRun({ failed: true, tasksBlocked: 0 }), "a failed run was marked successful");
  assert(isSuccessfulRun({ failed: false, tasksBlocked: 0 }), "an unblocked run was marked failed");
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
  assert(specReviewVerdict("**minor — step 5:** Optional detail.\n\nVERDICT: FAIL") === "PASS", "minor-only plan feedback still blocks implementation");
  assert(specReviewVerdict("**major — step 2:** Acceptance behavior is untestable.\n\nVERDICT: FAIL") === "FAIL", "major plan defect did not block implementation");
  assert(specReviewVerdict("No findings.\n\nVERDICT: PASS") === "PASS", "an explicit passing plan review was rejected");
  assert(specReviewVerdict("Review output without a valid verdict") === "FAIL", "malformed plan review was silently accepted");
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
