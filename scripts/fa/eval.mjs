// Замеры качества. Уровень 2: дороже инвариантов, но не требует человека.
// Репозиторий не меняется: модель только читает файлы и отвечает JSON.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, MODEL, OPENCODE_BIN, PATHS, ensureDir, makeRunId, nowIso } from "./config.mjs";
import { analyzeEvents, parseJsonlText } from "./metrics.mjs";

const ANSWER_PROMPT = [
  "Read js/data.js and css/styles.css in this repository. Do not edit anything.",
  "Answer with one JSON object and nothing else:",
  '{"storageKeys": <number of entries in STORAGE_KEYS>, "languages": [<keys of I18N>], "themes": [<values in [data-theme="..."] selectors in css/styles.css>]}'
].join("\n");

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
  if (out.models.length === 0) out.models = [MODEL];
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

function runModel(model, expected, timeoutMin) {
  const started = Date.now();
  const result = spawnSync(
    OPENCODE_BIN,
    ["run", "--agent", "fa-reviewer", "--model", model, "--format", "json", "--auto", "--title", `FA eval ${model}`, ANSWER_PROMPT],
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
  const verdict = score(answer, expected);
  const metrics = analyzeEvents(events);

  return {
    suite: "model",
    model,
    ok: verdict.pass,
    verdict: verdict.detail,
    checks: verdict.checks,
    answer,
    expected,
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

  const expected = await expectedAnswer();
  const results = options.models.map((model) => {
    try {
      return runModel(model, expected, options.timeoutMin);
    } catch (error) {
      return { suite: "model", model, ok: false, verdict: error.message, tokens: {}, tokenTotal: 0 };
    }
  });

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
