// Замеры качества. Уровень 2: дороже инвариантов, но не требует человека.
// Репозиторий не меняется: модель только читает файлы и отвечает JSON.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, OPENCODE_BIN, PATHS, ensureDir, makeRunId, nowIso } from "./config.mjs";
import { analyzeEvents, parseJsonlText } from "./metrics.mjs";
import { DEFAULT_MODELS, modelChain } from "./models.mjs";
import { ModelSession } from "./router.mjs";

const ANSWER_PROMPT = [
  "Read js/data.js and css/styles.css in this repository. Do not edit anything.",
  "Answer with one JSON object and nothing else:",
  '{"storageKeys": <number of entries in STORAGE_KEYS>, "languages": [<keys of I18N>], "themes": [<values in [data-theme="..."] selectors in css/styles.css>]}'
].join("\n");
const SIMPLE_PROMPT = [
  "Do this small non-coding task. Do not inspect or edit repository files.",
  'Return exactly one JSON object and nothing else: {"sum": 42, "label": "simple"}',
  "The sum is 19 + 23. The label must be the exact string shown."
].join("\n");
const SIMPLE_EXPECTED = { sum: 42, label: "simple" };

function parseArgs(argv) {
  const out = { suite: "invariants", models: [], json: false, timeoutMin: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite") out.suite = argv[++i] || "invariants";
    else if (arg === "--models") out.models = String(argv[++i] || "").split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--json") out.json = true;
    else if (arg === "--timeout") out.timeoutMin = Math.max(1, Number(argv[++i]) || 10);
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  if (out.models.length === 0 && out.suite === "model") {
    out.models = modelChain().filter((model) => model.available).map((model) => model.id);
  }
  return out;
}

async function expectedAnswer() {
  const dataUrl = `${pathToFileURL(join(ROOT, "js/data.js")).href}?eval=${Date.now()}`;
  const data = await import(dataUrl);
  const css = readFileSync(join(ROOT, "css/styles.css"), "utf8");
  const themes = [...css.matchAll(/\[data-theme="([^"]+)"\]/g)].map((match) => match[1]);
  return {
    storageKeys: Object.keys(data.STORAGE_KEYS).length,
    languages: Object.keys(data.I18N).sort(),
    themes: [...new Set(themes)].sort()
  };
}

function extractText(events) {
  const parts = [];
  for (const event of events) {
    const text = event.text || event.part?.text;
    if (typeof text === "string" && text.trim()) parts.push(text);
  }
  return parts.join("\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const left = [...new Set(a.map(String))].sort();
  const right = [...new Set(b.map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function score(answer, expected) {
  if (!answer) return { pass: false, checks: ["json"], detail: "no parsable JSON answer" };
  const checks = [];
  if (Number(answer.storageKeys) === expected.storageKeys) checks.push("storageKeys");
  if (sameSet(answer.languages, expected.languages)) checks.push("languages");
  if (sameSet(answer.themes, expected.themes)) checks.push("themes");
  return {
    pass: checks.length === 3,
    checks,
    detail: checks.length === 3 ? "ok" : `matched: ${checks.join(", ") || "none"}`
  };
}

function scoreSimple(answer) {
  const checks = [];
  if (Number(answer?.sum) === SIMPLE_EXPECTED.sum) checks.push("sum");
  if (answer?.label === SIMPLE_EXPECTED.label) checks.push("label");
  return {
    pass: checks.length === 2,
    checks,
    detail: checks.length === 2 ? "ok" : `matched: ${checks.join(", ") || "none"}`
  };
}

function runInvariants() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/verify.mjs"), "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000
  });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }

  return {
    suite: "invariants",
    ok: result.status === 0 && Boolean(parsed?.ok),
    durationMs: Date.now() - started,
    errors: parsed?.errors || [],
    warnings: parsed?.warnings || [],
    checks: parsed?.checks?.length ?? 0
  };
}

async function runModel(model, expected, timeoutMin, session) {
  const started = Date.now();
  const baseId = model.replace(/#[a-z0-9-]+$/i, "");
  const registryModel = DEFAULT_MODELS.find((item) => item.id === baseId);
  const simple = registryModel?.roles.includes("simple") || false;
  const role = simple ? "simple" : "reviewer";
  const reservation = await session.reserve(role, {
    estimateTokens: 20_000,
    maxWaitMs: 0,
    exclude: session
      .candidates(role)
      .filter((candidate) => candidate.id.replace(/#[a-z0-9-]+$/i, "") !== baseId)
      .map((candidate) => candidate.id)
  });
  if (!reservation.ok) {
    return {
      suite: "model",
      model,
      ok: false,
      verdict: reservation.reason,
      tokens: {},
      tokenTotal: 0,
      durationMs: Date.now() - started
    };
  }
  const prompt = simple ? SIMPLE_PROMPT : ANSWER_PROMPT;
  const expectedForModel = simple ? SIMPLE_EXPECTED : expected;
  const agent = simple ? "fa-scarce" : "fa-reviewer";
  const result = spawnSync(
    OPENCODE_BIN,
    ["run", "--agent", agent, "--model", model, "--format", "json", "--auto", "--title", `FA eval ${model}`, prompt],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMin * 60_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env }
    }
  );

  const stdout = result.stdout || "";
  const { events } = parseJsonlText(stdout);
  const text = extractText(events) || stdout;
  const answer = extractJson(text);
  const verdict = simple ? scoreSimple(answer) : score(answer, expected);
  const metrics = analyzeEvents(events);
  session.settle(reservation.reservation, { actualTokens: metrics.tokenTotal });

  return {
    suite: "model",
    model,
    ok: verdict.pass,
    verdict: verdict.detail,
    checks: verdict.checks,
    answer,
    expected: expectedForModel,
    durationMs: Date.now() - started,
    tokens: metrics.tokens,
    tokenTotal: metrics.tokenTotal,
    steps: metrics.steps,
    toolCalls: metrics.toolCalls,
    exitCode: result.status,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stderr: (result.stderr || "").slice(-2000)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log("usage: node scripts/fa/eval.mjs [--suite invariants|model] [--models a,b] [--json] [--timeout minutes]");
    return;
  }

  if (options.suite === "invariants") {
    const report = runInvariants();
    console.log(options.json ? JSON.stringify(report, null, 2) : `invariants: ${report.ok ? "PASS" : "FAIL"} (${report.checks} checks, ${report.durationMs} ms)`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (options.suite !== "model") {
    console.error(`unknown suite "${options.suite}"; use invariants or model`);
    process.exitCode = 2;
    return;
  }
  if (options.models.length === 0) {
    console.error("model eval has no available models; configure a provider key");
    process.exitCode = 2;
    return;
  }

  const expected = await expectedAnswer();
  const session = new ModelSession();
  const results = [];
  for (const model of options.models) {
    try {
      results.push(await runModel(model, expected, options.timeoutMin, session));
    } catch (error) {
      results.push({ suite: "model", model, ok: false, verdict: error.message, tokens: {}, tokenTotal: 0 });
    }
  }

  const report = {
    suite: "model",
    at: nowIso(),
    runId: makeRunId(),
    expected,
    results,
    ok: results.every((item) => item.ok)
  };

  const dir = ensureDir(PATHS.eval);
  const file = join(dir, `${report.runId}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`eval: ${report.ok ? "PASS" : "FAIL"} -> ${file}`);
    for (const item of results) {
      console.log(
        `${item.ok ? "ok  " : "FAIL"} ${item.model} — ${item.verdict}, steps ${item.steps ?? "?"}, tokens ${item.tokenTotal ?? 0}, ${Math.round((item.durationMs || 0) / 1000)} s`
      );
    }
  }

  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`eval failed: ${error.message}`);
  process.exitCode = 2;
});
