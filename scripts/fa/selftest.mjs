#!/usr/bin/env node
// Self-test harness-модулей без сети, модели и браузера. Быстрый и бесплатный.
// Проверяет контракты, на которых держится оркестратор.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ORDER, DEFAULT_MODELS, classifyFailure, estimateTokens, modelsForRole, parseModels, providerOf, roleSummary } from "./models.mjs";
import { Breaker, DailyCallLedger, ModelSession, RateLedger, roleCandidates } from "./router.mjs";
import { runPhase } from "./runner.mjs";
import { createLogRecord } from "./logging.mjs";
import { createOtlpSpan } from "./telemetry.mjs";
import { buildContext, expandFiles } from "./context.mjs";
import { addMemory, failureFingerprint, loadMemory, repeatedFailureTrend, searchMemory } from "./memory.mjs";
import { createRunState, isSuccessfulRun, loadRunState, saveRunState, setPhase } from "./state.mjs";
import { readQueue } from "./queue.mjs";
import { buildPlanPrompt, buildSpecReviewPrompt, specReviewVerdict, validatePrompts } from "./prompts.mjs";
import { TOOL_REGISTRY, TOOL_REGISTRY_VERSION, TOOLS } from "./mcp-server.mjs";
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

check("mcp.registry", () => {
  assert(TOOL_REGISTRY_VERSION === "1.0.0", "MCP tool registry version is missing");
  assert(TOOL_REGISTRY.length === TOOLS.length, "MCP registry does not describe every exposed tool");
  assert(
    TOOL_REGISTRY.every((entry, index) => entry.name === TOOLS[index].name && entry.version === TOOL_REGISTRY_VERSION),
    "MCP registry names or versions do not match the exposed tools"
  );
});

check("models.classify", () => {
  assert(classifyFailure("429 Too Many Requests") === "quota", "429 is not quota");
  assert(classifyFailure("401 Unauthorized") === "auth", "401 is not auth");
  assert(classifyFailure("HTTP status 202: request is pending") === "unavailable", "async HTTP response is not routed to fallback");
  assert(classifyFailure("provider.invalid-request: model reached end of life and is no longer available (410)") === "unavailable", "retired model is not classified for fallback");
  assert(classifyFailure("context_length_exceeded") === "context", "context is not classified");
  assert(classifyFailure("VERDICT: FAIL") === "other", "verdict is not a model failure");
  assert(estimateTokens(4000) === 1000, "estimateTokens is wrong");
  assert(providerOf("google/gemini-3.1-flash-lite") === "google", "providerOf is wrong");
  assert(parseModels("custom/model-v1")[0].provider === "custom", "custom provider parsing failed");
});

check("models.defaults", () => {
  const ids = DEFAULT_MODELS.map((model) => model.id);
  assert(ids.includes("google/gemini-2.5-flash"), "Gemini code fallback is missing from defaults");
  assert(ids.includes("google/gemini-3.6-flash"), "Gemini 3.6 Flash is missing from defaults");
  assert(ids.includes("google/gemini-3.8-flash"), "Gemini 3.8 Flash is missing from defaults");
  assert(ids.includes("google/gemini-4-hydrogen"), "Gemini 4 Hydrogen is missing from defaults");
  assert(ids.includes("nvidia/nemotron-3-ultra-550b-a55b"), "active NVIDIA Nemotron model is missing from defaults");
  assert(ids.includes("nvidia/nemotron-3.5-super-vl-120b-a12b"), "NVIDIA Nemotron 3.5 Super is missing from defaults");
  assert(!ids.some((id) => id.includes("deepseek")), "unavailable NVIDIA DeepSeek model remains in defaults");
  assert(DEFAULT_MODELS.find((model) => model.id === "nvidia/nemotron-3.5-lightning-30b-a3b")?.roles.join(",") === "simple", "Nemotron Lightning is not restricted to simple tasks");
  assert(DEFAULT_MODELS.every((model) => ["google", "nvidia"].includes(model.provider)), "a disallowed provider remains in defaults");
  for (const id of ["google/gemini-3.1-flash-lite", "google/gemini-3.5-flash-lite"]) {
    const model = DEFAULT_MODELS.find((item) => item.id === id);
    assert(model?.roles.length === 1 && model.roles[0] === "simple", `${id} is available outside simple non-coding tasks`);
    assert(model.rpm === 15 && model.tpm === 250_000 && model.dailyLimit === 500, `${id} has incorrect quota limits`);
  }
  for (const model of DEFAULT_MODELS.filter((item) => item.provider === "google" && !item.id.includes("flash-lite"))) {
    assert(model.rpm === 5 && model.tpm === 250_000 && model.dailyLimit === 20, `${model.id} has incorrect standard Google quotas`);
  }
  let missingNvidiaLimits = false;
  try {
    modelsForRole("executor", {
      ...process.env,
      FA_MODELS: "",
      FA_EXECUTOR_MODEL: "",
      FA_AVAILABLE_MODELS: "",
      FA_EXCLUDE_MODELS: "",
      GEMINI_API_KEY: "test-key",
      NVIDIA_API_KEY: "test-key",
      FA_NVIDIA_RPM: "",
      FA_NVIDIA_TPM: "",
      FA_NVIDIA_RPD: ""
    });
  } catch (error) {
    missingNvidiaLimits = /FA_NVIDIA_(?:RPM|TPM|RPD)/.test(error.message);
  }
  assert(missingNvidiaLimits, "NVIDIA models were available without account rate limits");
  const simpleIds = modelsForRole("simple", {
    ...process.env,
    FA_MODELS: "",
    FA_SIMPLE_MODEL: "",
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    GEMINI_API_KEY: "test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    NVIDIA_API_KEY: "test-key",
    FA_NVIDIA_RPM: "5",
    FA_NVIDIA_TPM: "250000",
    FA_NVIDIA_RPD: "20"
  }).map((model) => model.id);
  assert(
    simpleIds.slice(0, 3).join(",") ===
      "nvidia/nemotron-3.5-lightning-30b-a3b,google/gemini-3.5-flash-lite,google/gemini-3.1-flash-lite",
    "simple tasks do not follow NVIDIA, Gemini 3.5 Lite, Gemini 3.1 Lite ordering"
  );
  const opencodeConfig = readFileSync(join(ROOT, "opencode.jsonc"), "utf8");
  assert(opencodeConfig.includes('"modelID": "nvidia/nemotron-3-ultra-550b-a55b"'), "NVIDIA provider does not send its required API model ID");
  assert(opencodeConfig.includes('"modelID": "z-ai/glm-5.3-flash"'), "GLM-5.3-Flash is not configured for NVIDIA NIM");
  assert(opencodeConfig.includes('"modelID": "minimaxai/minimax-m3.1-flash"'), "MiniMax M3.1 Flash is not configured for NVIDIA NIM");
  assert(opencodeConfig.includes('"modelID": "poolside/laguna-xs-2.1"'), "Laguna XS 2.1 is not configured for NVIDIA NIM");
  assert(!opencodeConfig.includes("xerosharc") && !opencodeConfig.includes("openrouter"), "removed providers remain configured");
  assert(!ids.some((id) => id.startsWith("opencode/") || id.startsWith("anthropic/")), "unconfigured free/direct provider remains in defaults");
});

check("models.scarce-profile", () => {
  const agent = readFileSync(join(ROOT, ".opencode/agents/fa-scarce.md"), "utf8");
  const runner = readFileSync(join(ROOT, "scripts/fa/runner.mjs"), "utf8");
  assert(/^steps: 1$/m.test(agent), "scarce-model profile is not limited to one turn");
  assert(agent.includes('effect: deny'), "scarce-model profile does not deny tools");
  assert(runner.includes('model.scarce === true ? "fa-scarce" : agent'), "runner does not select the scarce-model profile");
});

check("execution.deadline", () => {
  const expiredAt = Date.now() - LIMITS.runBudgetMs - 1;
  assert(phaseTimeout(expiredAt, 30_000) === 0, "phase timeout exceeded the run deadline");
});

check("logging.correlation-id", () => {
  const attempt = createLogRecord({
    at: "2026-11-21T00:00:00.000Z",
    runId: "run-1",
    taskId: "T04",
    correlationId: "attempt-uuid",
    event: "model.start",
    data: { phase: "executor", model: "nvidia/example" }
  });
  const fallback = createLogRecord({
    at: "2026-11-21T00:00:01.000Z",
    runId: "run-1",
    taskId: "T04",
    correlationId: "attempt-uuid",
    event: "model.fallback",
    data: { phase: "executor", model: "nvidia/example" }
  });
  const runEvent = createLogRecord({
    at: "2026-11-21T00:00:02.000Z",
    runId: "run-1",
    event: "run.finish"
  });
  assert(attempt.correlationId === "attempt-uuid" && fallback.correlationId === attempt.correlationId, "events in one attempt do not share a correlation ID");
  assert(attempt.traceId === fallback.traceId && /^[a-f0-9]{32}$/.test(attempt.traceId), "correlated events do not share a valid trace ID");
  assert(/^[a-f0-9]{16}$/.test(attempt.spanId) && attempt.spanId !== fallback.spanId, "log events do not have unique valid span IDs");
  assert(runEvent.correlationId === "run-1:run", "run-level event does not have a run correlation ID");
  const otelSpan = createOtlpSpan(attempt);
  assert(otelSpan.traceId === attempt.traceId && otelSpan.spanId === attempt.spanId, "OTel span IDs do not match structured event IDs");
  assert(otelSpan.attributes.some((attribute) => attribute.key === "fa.model"), "OTel span is missing model attributes");
  const toolSpan = createOtlpSpan(
    { ...attempt, event: "tool.done", at: "2026-11-21T00:00:02.000Z", tool: "shell", toolCallId: "call-1", sandbox: "opencode-policy" },
    { ...attempt, event: "tool.start", at: "2026-11-21T00:00:01.000Z" }
  );
  assert(toolSpan.name === "tool shell", "tool span name does not identify the tool");
  assert(toolSpan.attributes.some((attribute) => attribute.key === "fa.tool"), "OTel tool span is missing tool metadata");
  assert(toolSpan.attributes.some((attribute) => attribute.key === "fa.sandbox"), "OTel tool span is missing sandbox metadata");
  assert(createLogRecord({
    at: "now",
    runId: "run-1",
    correlationId: "attempt-uuid",
    event: "test",
    data: { correlationId: "overridden" }
  }).correlationId === "attempt-uuid", "event data overrode the selected correlation ID");
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
    NVIDIA_API_KEY: "test-key",
    FA_NVIDIA_RPM: "5",
    FA_NVIDIA_TPM: "250000",
    FA_NVIDIA_RPD: "20"
  });
  for (const role of ["planner", "executor", "repair", "reviewer", "simple"]) {
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
      NVIDIA_API_KEY: "test-key",
      FA_NVIDIA_RPM: "5",
      FA_NVIDIA_TPM: "250000",
      FA_NVIDIA_RPD: "20"
    }
  }).length > 0, "no reviewer candidates");
  const independent = roleCandidates("reviewer", {
    env: {
      ...process.env,
      FA_AVAILABLE_MODELS: "",
      FA_EXCLUDE_MODELS: "",
      FA_REVIEWER_MODEL: "",
      FA_ALLOW_OPTIONAL: "",
      FA_MODELS: "google/gemini-2.5-flash,nvidia/nemotron-3-ultra-550b-a55b",
      GEMINI_API_KEY: "test-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GOOGLE_API_KEY: "",
      NVIDIA_API_KEY: "test-key",
      FA_NVIDIA_RPM: "5",
      FA_NVIDIA_TPM: "250000",
      FA_NVIDIA_RPD: "20"
    },
    exclude: ["google/gemini-2.5-flash"]
  });
  assert(
    independent.length > 0 &&
      independent[0].id === "nvidia/nemotron-3-ultra-550b-a55b" &&
      independent.some((model) => model.provider === "google"),
    "review exclusion did not select another NVIDIA reviewer while retaining cross-provider fallback"
  );
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
    NVIDIA_API_KEY: "test-key",
    FA_NVIDIA_RPM: "5",
    FA_NVIDIA_TPM: "250000",
    FA_NVIDIA_RPD: "20"
  };
  const executorIds = modelsForRole("executor", env).map((model) => model.id);
  assert(executorIds[0] === "nvidia/nemotron-3-ultra-550b-a55b", "Nemotron is not the default executor");
  assert(executorIds.some((id) => id.startsWith("google/")), "Google code model is missing from executor candidates");
  assert(!executorIds.some((id) => id.includes("flash-lite")), "Flash-Lite must not be used for code");
  assert(
    ["google/gemini-4-hydrogen", "google/gemini-3.8-flash", "google/gemini-3.6-flash", "google/gemini-2.5-flash"]
      .every((id, index, order) => index === 0 || executorIds.indexOf(order[index - 1]) < executorIds.indexOf(id)),
    "Google code models are not ordered Hydrogen, 3.8, 3.6, 2.5"
  );
  assert(Object.keys(DEFAULT_MODEL_ORDER).length === 5, "default model order has duplicate or missing role keys");
  for (const [role, order] of Object.entries(DEFAULT_MODEL_ORDER)) {
    assert(new Set(order).size === order.length, `${role} model order contains duplicate IDs`);
    assert(order.length > 0, `${role} model order is empty`);
  }
  assert(
    modelsForRole("reviewer", env)[0]?.id === "nvidia/nemotron-3-ultra-550b-a55b",
    "Nemotron Ultra is not the first reviewer model"
  );
  assert(
    modelsForRole("repair", env)[0]?.id === "nvidia/nemotron-3-ultra-550b-a55b",
    "Nemotron Ultra is not the first repair model"
  );
  const modelSource = readFileSync(join(ROOT, "scripts/fa/models.mjs"), "utf8");
  const orderSource = modelSource.match(/export const DEFAULT_MODEL_ORDER = \{([\s\S]*?)\n\};/)?.[1] || "";
  const declaredOrderRoles = [...orderSource.matchAll(/^\s{2}(planner|executor|repair|reviewer|simple):/gm)].map((match) => match[1]);
  assert(
    declaredOrderRoles.length === 5 && new Set(declaredOrderRoles).size === 5,
    "DEFAULT_MODEL_ORDER contains duplicate or missing role declarations"
  );
  const loopSource = readFileSync(join(ROOT, "scripts/fa/loop.mjs"), "utf8");
  assert(
    loopSource.includes("Math.min(LIMITS.taskTimeoutMs, LIMITS.repairTimeoutMs)"),
    "repair phases do not respect the dedicated timeout cap"
  );
  for (const role of ["planner", "executor", "repair", "reviewer"]) {
    const roleIds = modelsForRole(role, env).map((model) => model.id);
    assert(roleIds.includes("google/gemini-4-hydrogen"), `${role} does not retain Google Hydrogen fallback`);
    assert(roleIds.indexOf("google/gemini-4-hydrogen") < roleIds.indexOf("google/gemini-3.8-flash"), `${role} does not prefer Hydrogen over Gemini 3.8 Flash`);
  }
  assert(modelsForRole("repair", env)[0]?.provider === "nvidia", "NVIDIA is not the default repair model");
  assert(modelsForRole("planner", env)[0]?.provider === "nvidia", "NVIDIA is not the default planner");
  assert(modelsForRole("reviewer", env)[0]?.provider === "nvidia", "NVIDIA is not the default reviewer");
  const legacy = modelsForRole("executor", {
    ...env,
    FA_MODELS: "xerosharc/claude-sonnet-5-5,openrouter/baidu/ernie-5.5-flash-preview:free"
  });
  assert(legacy.map((model) => model.id).join(",") === executorIds.join(","), "legacy provider settings did not fall back to allowed defaults");
  const mixedLegacy = modelsForRole("executor", {
    ...env,
    FA_MODELS: "google/gemini-2.5-flash,nvidia/glm-5.3-flash,nvidia/nemotron-3-ultra-550b-a55b"
  });
  assert(mixedLegacy[0]?.id === "nvidia/nemotron-3-ultra-550b-a55b", "legacy model order overrode the NVIDIA executor preference");
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
  const selectedWithFallback = modelsForRole("executor", {
    ...env,
    FA_EXECUTOR_MODEL: "nvidia/nemotron-3-ultra-550b-a55b"
  });
  assert(
    selectedWithFallback[0]?.id === "nvidia/nemotron-3-ultra-550b-a55b" &&
      selectedWithFallback.some((model) => model.id === executorIds.at(-1)),
    "explicit model selection removed fallback candidates"
  );
  const liteBlocked = modelsForRole("executor", { ...env, FA_EXECUTOR_MODEL: "google/gemini-3.1-flash-lite" });
  assert(!liteBlocked.some((model) => model.id === "google/gemini-3.1-flash-lite"), "simple Flash-Lite model was allowed for code");
  const googleOnly = modelsForRole("executor", { ...env, NVIDIA_API_KEY: "", NVIDIA_NIM_API_KEY: "" });
  assert(googleOnly.length > 0 && googleOnly.every((model) => model.provider === "google"), "Google code fallback was unavailable without NVIDIA");
  const cappedNvidia = modelsForRole("executor", {
    ...env,
    FA_NVIDIA_RPM: "4",
    FA_NVIDIA_TPM: "120000",
    FA_NVIDIA_RPD: "90"
  })[0];
  assert(cappedNvidia.rpm === 4 && cappedNvidia.tpm === 120_000 && cappedNvidia.dailyLimit === 90, "NVIDIA account quota overrides were not applied");
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
  assert(ledger.waitMs(model, 1001) === Infinity, "a request larger than the TPM cap was not rejected");
});

check("router.provider-quotas", () => {
  let now = Date.UTC(2026, 10, 21, 12);
  const ledger = new RateLedger({ now: () => now });
  const firstModel = {
    id: "google/gemini-2.5-flash",
    provider: "google",
    quotaGroup: "google-standard",
    rpm: 2,
    tpm: 250_000
  };
  const secondModel = {
    ...firstModel,
    id: "google/gemini-3.6-flash"
  };
  ledger.record(firstModel, 100);
  assert(ledger.waitMs(secondModel, 100) === 0, "RPM cap applied before the request limit");
  ledger.record(secondModel, 100);
  assert(ledger.waitMs(firstModel, 100) > 0, "RPM was not shared across Google standard models");
  now += 61_000;
  assert(ledger.waitMs(firstModel, 100) === 0, "RPM window did not expire");

  const daily = new DailyCallLedger({ now: () => now });
  assert(daily.reserve(firstModel, 20), "first daily request was not reserved");
  assert(daily.used(secondModel) === 1, "Google daily requests were not shared across standard models");
  const lite = { ...firstModel, id: "google/gemini-3.1-flash-lite", quotaGroup: "google-lite" };
  assert(daily.used(lite) === 0, "lite quota was incorrectly combined with standard quota");
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
  const task = readQueue().find((item) => item.id === "T04");
  assert(task, "T04 is missing from the task queue");
  for (const marker of [
    'loadAccordionState()',
    'role="combobox"',
    '["interface"]',
    'aria-activedescendant',
    'role="listbox"',
    'role="option"',
    "AbortController",
    ".custom-css-area"
  ]) {
    assert(task.acceptance.includes(marker), `T04 acceptance is missing ${marker}`);
  }
  const planPrompt = buildPlanPrompt({ task, context: "fixture" });
  assert(planPrompt.includes("accessibility-критичного acceptance"), "plan prompt does not require concrete accessibility implementation details");
  const reviewPrompt = buildSpecReviewPrompt({ task, plan: "fixture" });
  assert(reviewPrompt.includes("accessibility-критичных частей"), "spec-review prompt does not assess accessibility requirements");
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
        GEMINI_API_KEY_2: "test-key-two",
        NVIDIA_API_KEY: "",
        NVIDIA_NIM_API_KEY: ""
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

await checkAsync("runner.timeout-fallback", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "fa-runner-"));
  const models = [
    { id: "google/first", provider: "google", context: 200_000, tpm: 250_000 },
    { id: "nvidia/second", provider: "nvidia", context: 200_000, tpm: 250_000 }
  ];
  const failed = new Set();
  const calls = [];
  const events = [];
  const session = {
    candidates: (_role, { exclude = [] } = {}) => models.filter((model) => !failed.has(model.id) && !exclude.includes(model.id)),
    reserve: async (_role, { exclude = [] } = {}) => {
      const model = models.find((item) => !failed.has(item.id) && !exclude.includes(item.id));
      return model ? { ok: true, model, reservation: { model, role: "planner" } } : { ok: false, reason: "no model available" };
    },
    providerEnv: (_model, env) => env,
    failover: (reservation) => failed.add(reservation.model.id),
    settle: () => {}
  };
  try {
    const result = await runPhase({
      session,
      role: "planner",
      agent: "fa-planner",
      prompt: "fixture",
      title: "timeout fallback test",
      timeoutMs: 2000,
      runDir,
      fileBase: "timeout-fallback",
      markers: ["PLAN_READY"],
      env: process.env,
      log: (event, data) => events.push({ event, ...data }),
      spawnImpl: async ({ args, timeoutMs }) => {
        calls.push({ model: args[args.indexOf("--model") + 1], timeoutMs });
        if (calls.length === 1) return { code: 1, signal: "SIGTERM", timedOut: true, spawnError: null, stdout: "", stderr: "" };
        return { code: 0, signal: null, timedOut: false, spawnError: null, stdout: '{"type":"text","text":"PLAN_READY"}\n', stderr: "" };
      }
    });
    assert(result.kind === "ok" && result.model === "nvidia/second", "runner did not continue with the second model after timeout");
    assert(result.fallbacks === 1, `timeout fallback count is wrong: ${result.fallbacks}`);
    assert(calls.length === 2 && calls[0].model === "google/first" && calls[1].model === "nvidia/second", "models were not attempted in order");
    assert(calls[0].timeoutMs <= 1000, "first model was not capped at half of the phase budget");
    assert(calls.every((call) => call.timeoutMs <= 2000), "per-model timeout exceeded the phase budget");
    assert(events.some((event) => event.event === "model.fallback" && event.message.includes("nvidia/second")), "timeout fallback was not logged");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

await checkAsync("runner.timeout-chain-exhausted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "fa-runner-"));
  const models = [
    { id: "google/first", provider: "google", context: 200_000, tpm: 250_000 },
    { id: "nvidia/second", provider: "nvidia", context: 200_000, tpm: 250_000 }
  ];
  const failed = new Set();
  const session = {
    candidates: (_role, { exclude = [] } = {}) => models.filter((model) => !failed.has(model.id) && !exclude.includes(model.id)),
    reserve: async (_role, { exclude = [] } = {}) => {
      const model = models.find((item) => !failed.has(item.id) && !exclude.includes(item.id));
      return model ? { ok: true, model, reservation: { model, role: "planner" } } : { ok: false, reason: "no model available" };
    },
    providerEnv: (_model, env) => env,
    failover: (reservation) => failed.add(reservation.model.id),
    settle: () => {}
  };
  try {
    const result = await runPhase({
      session,
      role: "planner",
      agent: "fa-planner",
      prompt: "fixture",
      title: "timeout exhaustion test",
      timeoutMs: 2000,
      runDir,
      fileBase: "timeout-exhausted",
      env: process.env,
      spawnImpl: async () => ({ code: 1, signal: "SIGTERM", timedOut: true, spawnError: null, stdout: "", stderr: "" })
    });
    assert(result.kind === "infra" && result.fallbacks === 1, "fully timed-out model chain did not report infrastructure failure");
    assert(result.model === "nvidia/second", "infrastructure result did not identify the last timed-out model");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
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
