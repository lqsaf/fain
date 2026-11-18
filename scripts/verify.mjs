#!/usr/bin/env node
// FA deterministic verification layer.
// Invariants only: fast, free, and independent of any model.
//
// Usage:
//   node scripts/verify.mjs [--json] [--quiet] [--strict]
//                           [--diff <base>] [--protected]
// Exit codes: 0 = pass, 1 = invariant failed, 2 = usage/config error.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { PROTECTED_GLOBS, isProtected, findSecrets, isAllowedVerifyCommand } from "./fa/policy.mjs";
import { parseQueue } from "./fa/queue.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes("--json");
const QUIET = ARGS.includes("--quiet");
const STRICT = ARGS.includes("--strict");
const PROTECTED_MODE = ARGS.includes("--protected");
const DIFF_INDEX = ARGS.indexOf("--diff");
const DIFF_BASE = DIFF_INDEX >= 0 ? ARGS[DIFF_INDEX + 1] : process.env.FA_DIFF_BASE || "";

const errors = [];
const warnings = [];
const checks = [];

function pass(name, detail = "") {
  checks.push({ name, status: "ok", detail });
}

function warn(name, message) {
  warnings.push({ name, message });
  checks.push({ name, status: "warn", detail: message });
}

function fail(name, message) {
  errors.push({ name, message });
  checks.push({ name, status: "fail", detail: message });
}

async function run(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === "string" ? detail : "");
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function walk(dir, predicate = () => true) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "logs") continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, predicate));
    else if (predicate(rel)) out.push(rel);
  }
  return out;
}

function flatten(value, prefix = "") {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(out, flatten(item, path));
    } else {
      out[path] = item;
    }
  }
  return out;
}

function stripJsonc(input) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    out += char;
  }

  return out.replace(/,\s*([}\]])/g, "$1");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function changedFiles(base) {
  if (!base) return [];
  if (base === "HEAD") {
    const tracked = git(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  }
  return git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
}

function addedLines(base) {
  if (!base) return "";
  if (base === "HEAD") {
    const diff = git(["diff", "HEAD"]);
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean)
      .map((file) => {
        try {
          return read(file).split("\n").map((line) => `+${line}`).join("\n");
        } catch {
          return "";
        }
      })
      .join("\n");
    return `${diff}\n${untracked}`;
  }
  return git(["diff", `${base}...HEAD`]);
}

const REQUIRED_FILES = [
  "AGENTS.md",
  "TASKS.md",
  "opencode.jsonc",
  "package.json",
  ".gitignore",
  "docs/harness/README.md",
  "docs/harness/OPERATING.md",
  "docs/CONVENTIONS.md",
  ".opencode/agents/fa.md",
  "scripts/verify.mjs"
];

const HARNESS_DOCS = [
  "README.md",
  "EXECUTION.md",
  "TOOLS.md",
  "CONTEXT.md",
  "LIFECYCLE.md",
  "OBSERVABILITY.md",
  "VERIFICATION.md",
  "GOVERNANCE.md",
  "OPERATING.md",
  "CHECKLIST.md",
  "PROMPTS.md"
];

async function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ROOT, file)));
  assert(missing.length === 0, `missing required files: ${missing.join(", ")}`);

  const missingDocs = HARNESS_DOCS.filter((file) => !existsSync(join(ROOT, "docs/harness", file)));
  assert(missingDocs.length === 0, `missing harness docs: ${missingDocs.join(", ")}`);
  return `${REQUIRED_FILES.length + HARNESS_DOCS.length} files`;
}

async function checkJsSyntax() {
  const files = [...walk("js", (file) => file.endsWith(".js"))];
  if (existsSync(join(ROOT, "worker.js"))) files.push("worker.js");
  assert(files.length > 0, "no JavaScript files found");

  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: ROOT,
      encoding: "utf8"
    });
    if (result.status !== 0) {
      failures.push(`${file}: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
    }
  }
  assert(failures.length === 0, failures.join("; "));
  return `${files.length} files`;
}

async function checkI18n() {
  const moduleUrl = `${pathToFileURL(join(ROOT, "js/data.js")).href}?verify=${Date.now()}`;
  const data = await import(moduleUrl);
  assert(data.I18N && typeof data.I18N === "object", "js/data.js does not export I18N");

  const langs = Object.keys(data.I18N);
  const expected = ["ru", "en", "zh"];
  assert(expected.every((lang) => langs.includes(lang)), `I18N languages must include ${expected.join(", ")}`);

  const flat = Object.fromEntries(langs.map((lang) => [lang, flatten(data.I18N[lang])]));
  const baseKeys = new Set(Object.keys(flat.ru));
  const problems = [];

  for (const lang of langs) {
    const keys = new Set(Object.keys(flat[lang]));
    for (const key of baseKeys) {
      if (!keys.has(key)) problems.push(`${lang}: missing "${key}"`);
    }
    for (const key of keys) {
      if (!baseKeys.has(key)) problems.push(`${lang}: extra "${key}"`);
    }
    for (const [key, value] of Object.entries(flat[lang])) {
      if (typeof value === "string" && value.trim() === "") {
        problems.push(`${lang}: empty "${key}"`);
      }
    }
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${langs.length} langs × ${baseKeys.size} keys`;
}

async function checkStorageKeys() {
  const moduleUrl = `${pathToFileURL(join(ROOT, "js/data.js")).href}?verify=${Date.now()}`;
  const data = await import(moduleUrl);
  const keys = data.STORAGE_KEYS;
  assert(keys && typeof keys === "object", "js/data.js does not export STORAGE_KEYS");

  const values = Object.entries(keys);
  const problems = [];
  const seen = new Set();

  for (const [name, value] of values) {
    if (typeof value !== "string") problems.push(`${name} is not a string`);
    if (!/^fain_[a-z0-9_]+_v\d+$/.test(value)) problems.push(`${name}="${value}" does not match fain_*_vN`);
    if (seen.has(value)) problems.push(`duplicate value ${value}`);
    seen.add(value);
  }

  const jsFiles = walk("js", (file) => file.endsWith(".js"));
  for (const file of jsFiles) {
    const text = read(file);
    for (const match of text.matchAll(/STORAGE_KEYS\.([A-Z_][A-Z0-9_]*)/g)) {
      if (!(match[1] in keys)) problems.push(`${file}: STORAGE_KEYS.${match[1]} is not defined`);
    }
    if (file !== "js/data.js") {
      for (const match of text.matchAll(/["'](fain_[a-z0-9_]+_v\d+)["']/g)) {
        problems.push(`${file}: hardcoded storage key "${match[1]}" (use STORAGE_KEYS)`);
      }
    }
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${values.length} keys`;
}

async function checkHtml() {
  const htmlFiles = ["index.html", "settings.html"].filter((file) => existsSync(join(ROOT, file)));
  assert(htmlFiles.length > 0, "no HTML pages found");

  const idsByPage = {};
  const problems = [];

  for (const file of htmlFiles) {
    const text = read(file);
    const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) problems.push(`${file}: duplicate ids ${[...new Set(duplicates)].join(", ")}`);
    idsByPage[file] = new Set(ids);

    const lang = text.match(/<html[^>]*\blang="([^"]+)"/i)?.[1];
    if (!lang || !["ru", "en", "zh"].includes(lang)) problems.push(`${file}: <html lang> must be ru/en/zh`);

    for (const match of text.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      const src = match[1].replace(/^\.\//, "");
      if (!existsSync(join(ROOT, src))) problems.push(`${file}: missing script ${src}`);
      if (!/<script[^>]*type="module"/.test(match[0])) problems.push(`${file}: script ${src} is not type="module"`);
    }

    for (const match of text.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) {
      const href = match[1];
      if (/^(https?:|#|data:)/.test(href)) continue;
      const target = href.replace(/^\.\//, "");
      if (!existsSync(join(ROOT, target))) problems.push(`${file}: missing linked file ${target}`);
    }
  }

  const dynamicIds = new Set(["fain-custom-css"]);
  const knownIds = new Set(Object.values(idsByPage).flatMap((set) => [...set]));
  const jsFiles = walk("js", (file) => file.endsWith(".js"));

  for (const file of jsFiles) {
    const text = read(file);
    for (const match of text.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
      const id = match[1];
      if (id.includes("${") || dynamicIds.has(id)) continue;
      if (!knownIds.has(id)) problems.push(`${file}: getElementById("${id}") has no element in HTML`);
    }
    for (const match of text.matchAll(/querySelector\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) {
      const id = match[1];
      if (!knownIds.has(id) && !dynamicIds.has(id)) problems.push(`${file}: querySelector("#${id}") has no element in HTML`);
    }
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${htmlFiles.length} pages, ${knownIds.size} ids`;
}

async function checkCss() {
  const cssFiles = walk("css", (file) => file.endsWith(".css"));
  assert(cssFiles.length > 0, "no CSS files found");

  const problems = [];
  const warningsLocal = [];

  for (const file of cssFiles) {
    const raw = read(file);
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const braces = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
    if (braces !== 0) problems.push(`${file}: unbalanced braces (${braces})`);

    const parens = (css.match(/\(/g) || []).length - (css.match(/\)/g) || []).length;
    if (parens !== 0) problems.push(`${file}: unbalanced parentheses (${parens})`);

    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const value = match[2].trim();
      if (/^(data:|https?:|#|var\()/.test(value)) continue;
      const target = join(dirname(join(ROOT, file)), value);
      if (!existsSync(target)) problems.push(`${file}: missing url() target ${value}`);
    }
  }

  const allCss = cssFiles.map((file) => read(file)).join("\n");
  for (const theme of ["light", "amber", "phosphor"]) {
    if (!allCss.includes(`[data-theme="${theme}"]`)) {
      warningsLocal.push(`css: no [data-theme="${theme}"] selector`);
    }
  }

  for (const message of warningsLocal) warn("css.themes", message);
  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${cssFiles.length} files`;
}

async function checkFeedJson() {
  if (!existsSync(join(ROOT, "feed.json"))) return "not present (skipped)";

  let data;
  try {
    data = JSON.parse(read("feed.json"));
  } catch (error) {
    throw new Error(`feed.json is not valid JSON: ${error.message}`);
  }

  assert(Array.isArray(data.items), "feed.json: items must be an array");
  assert(data.items.length <= 200, `feed.json: ${data.items.length} items > 200`);

  const ids = new Set();
  const problems = [];
  for (const [index, item] of data.items.entries()) {
    if (!item || typeof item !== "object") {
      problems.push(`item ${index} is not an object`);
      continue;
    }
    for (const field of ["id", "title", "summary", "url", "publishedAt"]) {
      if (!item[field]) problems.push(`item ${index}: missing ${field}`);
    }
    if (item.id) {
      if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
      ids.add(item.id);
    }
    if (item.publishedAt && Number.isNaN(new Date(item.publishedAt).getTime())) {
      problems.push(`item ${index}: invalid publishedAt`);
    }
    if (item.lang && !["ru", "en", "zh"].includes(item.lang)) {
      problems.push(`item ${index}: invalid lang ${item.lang}`);
    }
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${data.items.length} items`;
}

async function checkOpencodeConfig() {
  const path = join(ROOT, "opencode.jsonc");
  assert(existsSync(path), "opencode.jsonc is missing");

  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`opencode.jsonc is not valid JSONC: ${error.message}`);
  }

  assert(config.$schema, "opencode.jsonc: $schema is missing");
  const problems = [];

  const deprecated = ["permission", "tools", "disable", "maxSteps", "prompt", "temperature", "top_p"];
  for (const key of deprecated) {
    if (key in config) problems.push(`deprecated top-level key "${key}"`);
  }

  if (config.permissions !== undefined) {
    assert(Array.isArray(config.permissions), "permissions must be an array");
    for (const [index, rule] of config.permissions.entries()) {
      if (!rule || typeof rule !== "object") problems.push(`permissions[${index}] is not an object`);
      else {
        for (const field of ["action", "resource", "effect"]) {
          if (typeof rule[field] !== "string" || !rule[field]) problems.push(`permissions[${index}].${field} is invalid`);
        }
        if (!["allow", "ask", "deny"].includes(rule.effect)) problems.push(`permissions[${index}].effect is invalid`);
      }
    }
  }

  if (config.policies !== undefined) {
    assert(Array.isArray(config.policies), "policies must be an array");
    for (const [index, rule] of config.policies.entries()) {
      for (const field of ["action", "resource", "effect"]) {
        if (!rule || typeof rule[field] !== "string") problems.push(`policies[${index}].${field} is invalid`);
      }
    }
  }

  if (config.default_agent) {
    const agentFile = join(ROOT, ".opencode/agents", `${config.default_agent}.md`);
    const configAgent = config.agents && config.agents[config.default_agent];
    if (!existsSync(agentFile) && !configAgent) problems.push(`default_agent "${config.default_agent}" is not defined`);
  }

  const agentFiles = walk(".opencode/agents", (file) => file.endsWith(".md"));
  assert(agentFiles.length > 0, "no agents under .opencode/agents");
  for (const file of agentFiles) {
    const text = read(file);
    if (!text.startsWith("---")) continue;
    const end = text.indexOf("\n---", 3);
    const frontmatter = end > 0 ? text.slice(3, end) : "";
    for (const key of ["permission", "tools", "disable", "maxSteps"]) {
      if (new RegExp(`^${key}:`, "m").test(frontmatter)) problems.push(`${file}: deprecated frontmatter field "${key}"`);
    }
    if (!/^description:/m.test(frontmatter)) problems.push(`${file}: missing description`);
    if (!/^mode:/m.test(frontmatter)) problems.push(`${file}: missing mode`);
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return "ok";
}

async function checkQueue() {
  assert(existsSync(join(ROOT, "TASKS.md")), "TASKS.md is missing");
  const tasks = parseQueue(read("TASKS.md"));
  assert(tasks.length > 0, "TASKS.md has no tasks");

  const problems = [];
  const ids = new Set();
  let claimed = 0;

  for (const task of tasks) {
    if (ids.has(task.id)) problems.push(`duplicate id ${task.id}`);
    ids.add(task.id);
    if (!task.title) problems.push(`${task.id}: empty title`);
    if (!["todo", "claimed", "blocked", "done"].includes(task.status)) problems.push(`${task.id}: invalid status`);
    if (task.status === "claimed") claimed += 1;
    if (task.status === "done" && !task.fields.done) problems.push(`${task.id}: done without "- done:"`);
    if (task.status === "blocked" && !task.fields.blocked) problems.push(`${task.id}: blocked without "- blocked:"`);
    if (task.status === "todo" && !task.area) problems.push(`${task.id}: missing area`);
    if (task.status !== "done" && !task.acceptance) problems.push(`${task.id}: missing acceptance`);
    if (task.verify && !isAllowedVerifyCommand(task.verify)) {
      problems.push(`${task.id}: verify command is not allowlisted: ${task.verify}`);
    }
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency) && !tasks.some((item) => item.id === dependency)) {
        problems.push(`${task.id}: unknown dependency ${dependency}`);
      }
    }
  }

  if (claimed > 1) problems.push(`${claimed} claimed tasks (max 1)`);

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${tasks.length} tasks`;
}

async function checkPackageJson() {
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.scripts && pkg.scripts.verify, "package.json: scripts.verify is missing");
  assert(pkg.type === "module", 'package.json: "type": "module" is required');
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    warn("package.dependencies", "runtime dependencies appeared; the frontend is dependency-free");
  }
  if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
    warn("package.devDependencies", "dev dependencies appeared; FA assumes zero dependencies");
  }
  return "ok";
}

async function checkDocsSize() {
  const limits = { "AGENTS.md": 240 };
  const problems = [];
  const localWarnings = [];

  for (const [file, limit] of Object.entries(limits)) {
    const lines = read(file).split("\n").length;
    if (lines > limit) problems.push(`${file}: ${lines} lines > ${limit}`);
  }

  for (const file of HARNESS_DOCS) {
    const path = `docs/harness/${file}`;
    if (!existsSync(join(ROOT, path))) continue;
    const lines = read(path).split("\n").length;
    if (lines > 400) localWarnings.push(`${path}: ${lines} lines`);
  }

  for (const message of localWarnings) warn("docs.size", message);
  assert(problems.length === 0, problems.join("; "));
  return "ok";
}

async function checkDiff() {
  if (!DIFF_BASE) return "skipped (no --diff)";
  const files = changedFiles(DIFF_BASE);
  const added = addedLines(DIFF_BASE);
  const addedCount = added.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;

  if (files.length > 50) warn("diff.files", `${files.length} files changed (> 50)`);
  if (addedCount > 4000) warn("diff.lines", `${addedCount} added lines (> 4000)`);

  const secrets = findSecrets(added);
  assert(secrets.length === 0, `possible secrets in diff: ${secrets.map((hit) => hit.name).join(", ")}`);

  if (PROTECTED_MODE) {
    const protectedFiles = files.filter(isProtected);
    assert(
      protectedFiles.length === 0,
      `protected harness files changed: ${protectedFiles.join(", ")}`
    );
  }

  return `${files.length} files, ${addedCount} added lines`;
}

async function main() {
  await run("files.required", checkRequiredFiles);
  await run("js.syntax", checkJsSyntax);
  await run("i18n.parity", checkI18n);
  await run("storage.keys", checkStorageKeys);
  await run("html.contract", checkHtml);
  await run("css.integrity", checkCss);
  await run("feed.schema", checkFeedJson);
  await run("opencode.config", checkOpencodeConfig);
  await run("queue.protocol", checkQueue);
  await run("package.json", checkPackageJson);
  await run("docs.size", checkDocsSize);
  await run("diff.guard", checkDiff);

  const ok = errors.length === 0 && !(STRICT && warnings.length > 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok, errors, warnings, checks }, null, 2));
  } else {
    if (!QUIET) {
      for (const check of checks) {
        const icon = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
        console.log(`${icon} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
      }
    }

    for (const error of errors) console.error(`\nFAIL ${error.name}: ${error.message}`);
    for (const warning of warnings) console.error(`\nwarn ${warning.name}: ${warning.message}`);

    const summary = `FA verify: ${ok ? "PASS" : "FAIL"} — ${checks.length} checks, ${errors.length} errors, ${warnings.length} warnings`;
    console.log(`\n${summary}`);
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`FA verify crashed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 2;
});
