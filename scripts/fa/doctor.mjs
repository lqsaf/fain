#!/usr/bin/env node
// Doctor: проверяет окружение, конфиг, модели, ключи, браузер и очередь.
// Ничего не меняет. Это первый шаг каждого запуска и ручная диагностика.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_BRANCH, BRANCH, LIMITS, OPENCODE_BIN, PATHS, ROOT, isCi } from "./config.mjs";
import {
  availableModels,
  modelChain,
  probeGatewayModels,
  probeOpenCodeModels,
  roleSummary
} from "./models.mjs";
import { queueStats, readQueue } from "./queue.mjs";
import { memoryStats } from "./memory.mjs";
import { findChrome } from "./ui.mjs";
import { validatePrompts } from "./prompts.mjs";

const PROBE_TTL_MS = Number(process.env.FA_PROBE_TTL_SEC || 900) * 1000;

function sh(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: options.timeout || 60_000
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || ""
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadProbeCache() {
  const file = join(PATHS.state, "probe.json");
  const data = readJson(file);
  if (!data || !Array.isArray(data.ids)) return null;
  if (Date.now() - Number(data.at || 0) > PROBE_TTL_MS) return null;
  return data;
}

function saveProbeCache(ids, source) {
  try {
    mkdirSync(PATHS.state, { recursive: true });
    writeFileSync(
      join(PATHS.state, "probe.json"),
      `${JSON.stringify({ at: Date.now(), source, ids }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // кэш — оптимизация, не условие запуска
  }
}

export async function probeModels({ env = process.env, useCache = true } = {}) {
  if (useCache) {
    const cached = loadProbeCache();
    if (cached) return { ok: true, cached: true, ids: cached.ids, source: cached.source };
  }

  const opencode = probeOpenCodeModels({ bin: env.FA_OPENCODE_BIN || OPENCODE_BIN });
  const gateway = await probeGatewayModels({ apiKey: env.XEROSHARC_API_KEY || "" });
  const ids = [...new Set([...(opencode.ids || []), ...(gateway.ids || [])])];
  const source = [opencode.ok ? "opencode" : "", gateway.ok ? "gateway" : ""].filter(Boolean).join("+") || "none";
  if (ids.length > 0) saveProbeCache(ids, source);
  return {
    ok: opencode.ok || gateway.ok,
    cached: false,
    ids,
    source,
    opencode: { ok: opencode.ok, reason: opencode.reason || "" },
    gateway: { ok: gateway.ok, reason: gateway.reason || "" }
  };
}

export async function preflight({ env = process.env, ci = isCi(), probe = null, requireUi = false } = {}) {
  const problems = [];
  const warnings = [];
  const checks = [];
  const chain = modelChain(env);
  const usable = ci ? chain.filter((model) => model.available) : chain;

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", status: major >= 22 ? "ok" : "fail", detail: process.version });
  if (!Number.isFinite(major) || major < 22) problems.push(`Node 22+ required, got ${process.version}`);

  for (const file of ["AGENTS.md", "TASKS.md", "opencode.jsonc", "package.json", "scripts/verify.mjs", "scripts/fa/loop.mjs"]) {
    if (!existsSync(join(ROOT, file))) problems.push(`missing ${file}`);
  }

  const version = sh(OPENCODE_BIN, ["--version"], { timeout: 30_000 });
  checks.push({ name: "opencode", status: version.ok ? "ok" : "fail", detail: version.stdout || version.error });
  if (!version.ok) problems.push(`opencode not found (${OPENCODE_BIN}): ${version.error || version.stderr}`);

  const repo = sh("git", ["rev-parse", "--is-inside-work-tree"]);
  if (!repo.ok) problems.push("not a git repository");

  const remote = sh("git", ["remote", "get-url", "origin"]);
  if (!remote.ok) problems.push("git remote origin is missing");

  if (ci && usable.length === 0) {
    const details = chain.map((model) => `${model.id} (${model.keyNames.join("/") || "provider auth"})`);
    problems.push(`no provider key for any configured model: ${details.join(", ")}`);
  } else if (ci && usable.length < chain.length) {
    const missing = chain
      .filter((model) => !model.available)
      .map((model) => `${model.id} (${model.keyNames.join("/") || "provider auth"})`);
    warnings.push(`model fallback is incomplete; missing key: ${missing.join(", ")}`);
  }

  const roles = roleSummary(env);
  for (const [role, models] of Object.entries(roles)) {
    if (models.length === 0) problems.push(`no model for role ${role}`);
  }

  const probeResult = probe || (await probeModels({ env }));
  if (probeResult && probeResult.ok && probeResult.ids.length > 0) {
    const known = new Set(probeResult.ids);
    for (const model of chain) {
      const base = model.id.replace(/#[a-z0-9-]+$/i, "");
      if (!model.optional && !known.has(base) && probeResult.source.includes("opencode")) {
        warnings.push(`model ${base} is not listed by opencode models`);
      }
    }
  }

  const promptProblems = validatePrompts();
  for (const problem of promptProblems) problems.push(`prompts: ${problem}`);

  let stats = null;
  try {
    stats = queueStats(readQueue());
  } catch (error) {
    problems.push(`TASKS.md is not parseable: ${error.message}`);
  }

  const chrome = findChrome(env);
  checks.push({ name: "chrome", status: chrome ? "ok" : "warn", detail: chrome || "not found" });
  if (!chrome && requireUi) problems.push("headless Chrome is required for UI verification but was not found");
  if (!chrome && !requireUi) warnings.push("headless Chrome not found; UI checks will be skipped");

  const clean = sh("git", ["status", "--porcelain"]);
  if (!clean.ok) warnings.push("git status failed");
  else if (clean.stdout) warnings.push("worktree is dirty; local run will refuse without --force-local");

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    checks,
    chain,
    usable,
    roles,
    probe: probeResult,
    stats,
    chrome,
    opencodeVersion: version.stdout,
    memory: memoryStats(),
    limits: LIMITS,
    branch: `${BRANCH} -> ${BASE_BRANCH}`
  };
}

function printHuman(result) {
  console.log("FA doctor");
  console.log(`  branch:     ${result.branch}`);
  console.log(`  node:       ${process.version}`);
  console.log(`  opencode:   ${result.opencodeVersion || "not found"}`);
  console.log(`  chrome:     ${result.chrome || "not found (UI skipped)"}`);
  console.log(`  models:     ${result.chain.map((model) => `${model.id}${model.available ? "" : " [no key]"}`).join(" -> ")}`);
  console.log(`  roles:      ${Object.entries(result.roles).map(([role, ids]) => `${role}=${ids.join(",") || "none"}`).join(" | ")}`);
  console.log(`  probe:      ${result.probe?.source || "none"}${result.probe?.cached ? " (cached)" : ""} — ${result.probe?.ids?.length || 0} ids`);
  console.log(`  memory:     ${result.memory?.total || 0} entries`);
  console.log(`  limits:     run ${Math.round(result.limits.runBudgetMs / 60_000)} min, task ${Math.round(result.limits.taskTimeoutMs / 60_000)} min, attempts ${result.limits.maxAttempts}, repairs ${result.limits.maxRepairs}`);
  if (result.stats) {
    console.log(
      `  queue:      ${result.stats.total} total, ${result.stats.todo} todo, ${result.stats.claimed} claimed, ${result.stats.blocked} blocked, ${result.stats.done} done, ${result.stats.waiting} waiting`
    );
  }
  for (const check of result.checks) {
    const icon = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
    console.log(`  ${icon} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  for (const warning of result.warnings) console.log(`  warn:       ${warning}`);
  for (const problem of result.problems) console.error(`  FAIL:       ${problem}`);
  console.log(result.ok ? "doctor: OK" : "doctor: FAILED");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/fa/doctor.mjs [--json] [--no-probe] [--require-ui] [--verify]");
    return;
  }
  const result = await preflight({
    probe: args.includes("--no-probe") ? { ok: false, ids: [], source: "disabled" } : null,
    requireUi: args.includes("--require-ui")
  });

  if (args.includes("--verify")) {
    const verify = sh(process.execPath, [join(ROOT, "scripts/verify.mjs"), "--json"], { timeout: 180_000 });
    result.verify = verify.ok ? JSON.parse(verify.stdout || "{}") : { ok: false, error: verify.stderr || verify.stdout };
    if (!verify.ok) result.problems.push("npm run verify failed");
    result.ok = result.problems.length === 0;
  }

  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exitCode = result.ok ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`doctor failed: ${error.stack || error.message}`);
    process.exitCode = 2;
  });
}
