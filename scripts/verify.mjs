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
const ALLOW_TASKS = ARGS.includes("--allow-tasks");
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
  ".github/workflows/fa-quarterly-audit.yml",
  "docs/harness/README.md",
  "docs/harness/OPERATING.md",
  "docs/CONVENTIONS.md",
  ".opencode/agents/fa.md",
  ".opencode/agents/fa-planner.md",
  ".opencode/agents/fa-reviewer.md",
  ".opencode/agents/fa-scarce.md",
  "scripts/verify.mjs",
  "scripts/fa/models.mjs",
  "scripts/fa/router.mjs",
  "scripts/fa/telemetry.mjs",
  "scripts/fa/runner.mjs",
  "scripts/fa/context.mjs",
  "scripts/fa/memory.mjs",
  "scripts/fa/state.mjs",
  "scripts/fa/prompts.mjs",
  "scripts/fa/doctor.mjs",
  "scripts/fa/ui.mjs",
  "scripts/fa/mcp-server.mjs",
  "scripts/fa/selftest.mjs"
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
  "PROMPTS.md",
  "TEMPLATE.md"
];

async function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ROOT, file)));
  assert(missing.length === 0, `missing required files: ${missing.join(", ")}`);

  const missingDocs = HARNESS_DOCS.filter((file) => !existsSync(join(ROOT, "docs/harness", file)));
  assert(missingDocs.length === 0, `missing harness docs: ${missingDocs.join(", ")}`);
  return `${REQUIRED_FILES.length + HARNESS_DOCS.length} files`;
}

async function checkJsSyntax() {
  const files = [...walk("js", (file) => file.endsWith(".js")), ...walk("scripts", (file) => file.endsWith(".mjs"))];
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

  const deprecated = ["permission", "tools", "disable", "maxSteps", "prompt", "temperature", "top_p", "provider"];
  for (const key of deprecated) {
    if (key in config) problems.push(`deprecated top-level key "${key}" (use V2 schema)`);
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

  if (config.providers !== undefined) {
    assert(config.providers && typeof config.providers === "object", "providers must be an object");
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!provider || typeof provider !== "object") {
        problems.push(`providers.${id} is not an object`);
        continue;
      }
      if (provider.npm) problems.push(`providers.${id}.npm is V1 (use package)`);
      if (provider.options) problems.push(`providers.${id}.options is V1 (use settings)`);
      if (provider.package && !/^(@opencode\/ai\/providers\/|[a-z0-9@][^"]*$)/.test(provider.package)) {
        problems.push(`providers.${id}.package is invalid`);
      }
      if (provider.models && typeof provider.models !== "object") problems.push(`providers.${id}.models must be an object`);
    }
  }

  if (config.mcp?.servers) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      if (!server || typeof server !== "object") problems.push(`mcp.servers.${name} is not an object`);
      else if (server.type === "local") {
        if (!Array.isArray(server.command) || server.command.length === 0) {
          problems.push(`mcp.servers.${name}.command must be a non-empty array`);
        }
      } else if (server.type === "remote") {
        if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) {
          problems.push(`mcp.servers.${name}.url must be absolute`);
        }
      } else {
        problems.push(`mcp.servers.${name}.type must be local or remote`);
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
    for (const key of ["permission", "tools", "disable", "maxSteps", "prompt", "temperature"]) {
      if (new RegExp(`^${key}:`, "m").test(frontmatter)) problems.push(`${file}: deprecated frontmatter field "${key}"`);
    }
    if (!/^description:/m.test(frontmatter)) problems.push(`${file}: missing description`);
    if (!/^mode:/m.test(frontmatter)) problems.push(`${file}: missing mode`);
    const mode = frontmatter.match(/^mode:\s*(\S+)/m)?.[1];
    if (mode && !["primary", "subagent", "all"].includes(mode)) problems.push(`${file}: invalid mode "${mode}"`);
    if (!/^permissions:/m.test(frontmatter)) problems.push(`${file}: missing permissions`);
  }

  const faAgent = read(".opencode/agents/fa.md");
  for (const marker of ["TASKS.md", "git commit", "npm install", "webfetch", "subagent"]) {
    if (!faAgent.includes(marker)) problems.push(`fa.md does not mention boundary "${marker}"`);
  }

  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return "ok (V2)";
}

async function checkModelRegistry() {
  const moduleUrl = `${pathToFileURL(join(ROOT, "scripts/fa/models.mjs")).href}?verify=${Date.now()}`;
  const models = await import(moduleUrl);

  assert(Array.isArray(models.DEFAULT_MODELS) && models.DEFAULT_MODELS.length > 0, "models.mjs: DEFAULT_MODELS is empty");

  const problems = [];
  const ids = new Set();
  for (const model of models.DEFAULT_MODELS) {
    if (!model || typeof model !== "object") {
      problems.push("models.mjs: model entry is not an object");
      continue;
    }
    if (!/^[a-z0-9-]+\/[A-Za-z0-9._:/-]+(?:#[a-z0-9-]+)?$/.test(String(model.id || ""))) {
      problems.push(`models.mjs: invalid model id "${model.id}"`);
    }
    if (ids.has(model.id)) problems.push(`models.mjs: duplicate model id "${model.id}"`);
    ids.add(model.id);
    if (model.provider !== models.providerOf(model.id)) {
      problems.push(`models.mjs: provider mismatch for "${model.id}"`);
    }
    if (!models.ALLOWED_PROVIDERS.has(model.provider)) {
      problems.push(`models.mjs: disallowed provider "${model.provider}"`);
    }
    if (!Array.isArray(model.roles) || model.roles.length === 0) {
      problems.push(`models.mjs: ${model.id} has no roles`);
    }
    for (const role of model.roles || []) {
      if (!models.MODEL_ROLES.includes(role)) problems.push(`models.mjs: ${model.id} has unknown role ${role}`);
    }
    if (model.provider === "google" && Number(model.tpm) !== 250_000) {
      problems.push(`models.mjs: ${model.id} must use the configured Google TPM ceiling`);
    }
    if (model.provider === "google" && (!Number(model.rpm) || !Number(model.dailyLimit))) {
      problems.push(`models.mjs: ${model.id} is missing Google RPM/RPD limits`);
    }
    if (!(Number(model.context) > 0)) problems.push(`models.mjs: ${model.id} has no context limit`);
  }

  const roles = models.roleSummary({
    ...process.env,
    FA_MODELS: "",
    FA_PLANNER_MODEL: "",
    FA_EXECUTOR_MODEL: "",
    FA_REPAIR_MODEL: "",
    FA_REVIEWER_MODEL: "",
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    FA_ALLOW_OPTIONAL: "",
    GEMINI_API_KEY: "verify-test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    NVIDIA_API_KEY: "verify-test-key",
    FA_NVIDIA_RPM: "5",
    FA_NVIDIA_TPM: "250000",
    FA_NVIDIA_RPD: "20"
  });
  for (const role of models.MODEL_ROLES) {
    if (!Array.isArray(roles[role]) || roles[role].length === 0) problems.push(`models.mjs: role ${role} is empty`);
  }
  const nvidiaModel = models.DEFAULT_MODELS.find((model) => model.id === "nvidia/nemotron-3-ultra-550b-a55b");
  if (!nvidiaModel || nvidiaModel.provider !== "nvidia") {
    problems.push("models.mjs: NVIDIA NIM must use the active Nemotron model");
  }
  const configuredNvidiaIds = [
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/glm-5.3-flash",
    "nvidia/minimax-m3.1-flash",
    "nvidia/laguna-xs-2.1",
    "nvidia/nemotron-3-ultra-550b-a55b"
  ];
  const nvidiaIds = new Set(models.DEFAULT_MODELS.filter((model) => model.provider === "nvidia").map((model) => model.id));
  for (const id of configuredNvidiaIds) {
    if (!nvidiaIds.has(id)) problems.push(`models.mjs: NVIDIA catalog model ${id} is missing`);
  }
  if (models.DEFAULT_MODELS.some((model) => !models.ALLOWED_PROVIDERS.has(model.provider))) {
    problems.push("models.mjs: defaults must contain only Gemini and NVIDIA");
  }
  const legacyEnv = {
    ...process.env,
    FA_MODELS: "xerosharc/claude-sonnet-5-5,openrouter/baidu/ernie-5.5-flash-preview:free",
    FA_PLANNER_MODEL: "",
    FA_EXECUTOR_MODEL: "",
    FA_REPAIR_MODEL: "",
    FA_REVIEWER_MODEL: "",
    FA_AVAILABLE_MODELS: "",
    FA_EXCLUDE_MODELS: "",
    FA_ALLOW_OPTIONAL: "",
    GEMINI_API_KEY: "verify-test-key",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    NVIDIA_API_KEY: "verify-test-key",
    NVIDIA_NIM_API_KEY: "",
    FA_NVIDIA_RPM: "5",
    FA_NVIDIA_TPM: "250000",
    FA_NVIDIA_RPD: "20"
  };
  const simpleModels = models.modelsForRole("simple", {
    ...legacyEnv,
    FA_MODELS: "",
    FA_SIMPLE_MODEL: ""
  }).map((model) => model.id);
  if (
    simpleModels.slice(0, 3).join(",") !==
    "nvidia/nemotron-3.5-lightning-30b-a3b,google/gemini-3.5-flash-lite,google/gemini-3.1-flash-lite"
  ) {
    problems.push("models.mjs: simple tasks must use NVIDIA Lightning, then Gemini 3.5 and 3.1 Flash-Lite");
  }
  const loopSource = read("scripts/fa/loop.mjs");
  if (!loopSource.includes('task?.area === "simple"') || !loopSource.includes("\\.(?:md|mdx|txt|rst|adoc)$")) {
    problems.push("loop.mjs: simple-model routing is not restricted to explicitly labeled text-only tasks");
  }
  const defaultExecutor = models.modelsForRole("executor", {
    ...legacyEnv,
    FA_MODELS: "",
    FA_EXECUTOR_MODEL: ""
  }).map((model) => model.id);
  if (defaultExecutor[0] !== "nvidia/nemotron-3-ultra-550b-a55b" || !defaultExecutor.includes("google/gemini-2.5-flash") || defaultExecutor.includes("google/gemini-3.1-flash-lite")) {
    problems.push("models.mjs: executor must prefer Nemotron via NVIDIA and retain Gemini fallback");
  }
  const googleCodeOrder = [
    "google/gemini-4-hydrogen",
    "google/gemini-3.8-flash",
    "google/gemini-3.6-flash",
    "google/gemini-2.5-flash"
  ].map((id) => defaultExecutor.indexOf(id));
  if (googleCodeOrder.some((index) => index < 0) || googleCodeOrder.some((index, i) => i > 0 && googleCodeOrder[i - 1] >= index)) {
    problems.push("models.mjs: Google code fallback order must be Hydrogen, 3.8, 3.6, 2.5");
  }
  const roleLeads = ["planner", "executor", "repair", "reviewer"].map(
    (role) => models.modelsForRole(role, legacyEnv)[0]?.id
  );
  if (roleLeads[3] !== "nvidia/nemotron-3-ultra-550b-a55b") {
    problems.push("models.mjs: reviewer must prefer Nemotron Ultra");
  }
  if (roleLeads[2] !== "nvidia/nemotron-3-ultra-550b-a55b") {
    problems.push("models.mjs: repair must prefer Nemotron Ultra");
  }
  for (const [role, order] of Object.entries(models.DEFAULT_MODEL_ORDER)) {
    if (new Set(order).size !== order.length) {
      problems.push(`models.mjs: ${role} default order contains duplicate model IDs`);
    }
    if (!Array.isArray(roles[role]) || !models.MODEL_ROLES.includes(role)) {
      problems.push(`models.mjs: unexpected default order role "${role}"`);
    }
  }
  const modelSource = read("scripts/fa/models.mjs");
  const orderSource = modelSource.match(/export const DEFAULT_MODEL_ORDER = \{([\s\S]*?)\n\};/)?.[1] || "";
  const declaredOrderRoles = [...orderSource.matchAll(/^\s{2}(planner|executor|repair|reviewer|simple):/gm)].map((match) => match[1]);
  if (declaredOrderRoles.length !== 5 || new Set(declaredOrderRoles).size !== 5) {
    problems.push("models.mjs: DEFAULT_MODEL_ORDER must declare each role exactly once");
  }
  for (const role of ["planner", "executor", "repair", "reviewer"]) {
    const candidates = models.modelsForRole(role, legacyEnv);
    if (candidates[0]?.provider !== "nvidia" || !candidates.some((model) => model.provider === "google")) {
      problems.push(`models.mjs: ${role} must prefer NVIDIA and retain Google code-model fallback`);
    }
    const hydrogenIndex = candidates.findIndex((model) => model.id === "google/gemini-4-hydrogen");
    const flash38Index = candidates.findIndex((model) => model.id === "google/gemini-3.8-flash");
    if (hydrogenIndex < 0 || flash38Index < 0 || hydrogenIndex > flash38Index) {
      problems.push(`models.mjs: ${role} must prefer Google Hydrogen over Gemini 3.8 Flash`);
    }
  }
  if (models.modelsForRole("executor", {
    ...legacyEnv,
    FA_EXECUTOR_MODEL: "google/gemini-3.1-flash-lite"
  }).some((model) => model.id === "google/gemini-3.1-flash-lite")) {
    problems.push("models.mjs: Flash-Lite must not be selectable for code execution");
  }
  const mixedLegacy = models.modelsForRole("executor", {
    ...legacyEnv,
    FA_MODELS: "google/gemini-2.5-flash,nvidia/glm-5.3-flash,nvidia/nemotron-3-ultra-550b-a55b"
  });
  if (mixedLegacy[0]?.id !== "nvidia/nemotron-3-ultra-550b-a55b") {
    problems.push("models.mjs: legacy FA_MODELS ordering overrode the NVIDIA executor default");
  }
  for (const role of models.MODEL_ROLES) {
    const roleEnv = { ...legacyEnv, [`FA_${role.toUpperCase()}_MODEL`]: "xerosharc/claude-sonnet-5-5" };
    if (models.modelsForRole(role, roleEnv).some((model) => !models.ALLOWED_PROVIDERS.has(model.provider))) {
      problems.push(`models.mjs: stale ${role} override bypassed provider allowlist`);
    }
  }
  const staleProbe = models.modelsForRole("executor", {
    ...legacyEnv,
    FA_MODELS: "",
    FA_AVAILABLE_MODELS: "xerosharc/claude-sonnet-5-5"
  });
  if (staleProbe[0]?.id !== "nvidia/nemotron-3-ultra-550b-a55b") {
    problems.push("models.mjs: stale provider probe blocked the Nemotron executor default");
  }
  if (!read("opencode.jsonc").includes('"modelID": "nvidia/nemotron-3-ultra-550b-a55b"')) {
    problems.push("opencode.jsonc: NVIDIA NIM modelID does not match the live API model ID");
  }
  const config = JSON.parse(stripJsonc(read("opencode.jsonc")));
  const configuredModels = config.providers?.nvidia?.models || {};
  const requiredModelIds = {
    "nemotron-3.5-super-vl-120b-a12b": "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nemotron-3.5-lightning-30b-a3b": "nvidia/nemotron-3.5-lightning-30b-a3b",
    "glm-5.3-flash": "z-ai/glm-5.3-flash",
    "minimax-m3.1-flash": "minimaxai/minimax-m3.1-flash",
    "laguna-xs-2.1": "poolside/laguna-xs-2.1",
    "nemotron-3-ultra-550b-a55b": "nvidia/nemotron-3-ultra-550b-a55b"
  };
  const workflow = read(".github/workflows/fa.yml");
  for (const [id, modelID] of Object.entries(requiredModelIds)) {
    if (configuredModels[id]?.modelID !== modelID) {
      problems.push(`opencode.jsonc: NVIDIA model ${id} must use API ID ${modelID}`);
    }
    if (!workflow.includes(`- nvidia/${id}`)) {
      problems.push(`fa.yml: workflow_dispatch is missing NVIDIA model choice nvidia/${id}`);
    }
  }
  if (configuredModels["deepseek-v4.1-flash"] || workflow.includes("nvidia/deepseek-v4.1-flash")) {
    problems.push("DeepSeek V4.1 Flash is unavailable and must not be configured");
  }
  if (read("opencode.jsonc").includes("deepseek-v4.1-flash")) {
    problems.push("opencode.jsonc: unavailable DeepSeek V4.1 Flash remains configured");
  }
  const taskConfig = read("scripts/fa/config.mjs");
  if (
    !taskConfig.includes('readNumber("FA_REPAIR_TIMEOUT_MIN", 30)') ||
    !taskConfig.includes("repairTimeoutMin > 30")
  ) {
    problems.push("config.mjs: repair phase must enforce a maximum 30-minute timeout");
  }
  if (!read("scripts/fa/loop.mjs").includes("Math.min(LIMITS.taskTimeoutMs, LIMITS.repairTimeoutMs)")) {
    problems.push("loop.mjs: repair phase does not enforce its dedicated timeout cap");
  }
  const googleModels = config.providers?.google?.models || {};
  for (const id of [
    "gemini-2.5-flash",
    "gemini-3.6-flash",
    "gemini-3.8-flash",
    "gemini-4-hydrogen",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite"
  ]) {
    if (!googleModels[id]) problems.push(`opencode.jsonc: Google model ${id} is not configured`);
  }
  if (/xerosharc|openrouter/i.test(read("opencode.jsonc"))) {
    problems.push("opencode.jsonc: removed provider configuration remains");
  }
  if (/XEROSHARC_API_KEY|OPENROUTER_API_KEY/.test(read(".github/workflows/fa.yml"))) {
    problems.push("fa.yml: removed provider secrets remain in workflow");
  }
  if (/vars\.FA_(?:PLANNER|EXECUTOR|REPAIR|REVIEWER)_MODEL/.test(workflow)) {
    problems.push("fa.yml: stale repository role variables can override the default route");
  }

  assert(models.classifyFailure("429 too many requests") === "quota", "models.mjs: quota classification is broken");
  assert(
    models.classifyFailure("provider.invalid-request: model reached end of life and is no longer available (410)") === "unavailable",
    "models.mjs: retired model errors must trigger fallback"
  );
  assert(models.classifyFailure("HTTP status 202: request is pending") === "unavailable", "models.mjs: asynchronous responses must trigger fallback");
  assert(models.classifyFailure("VERDICT: FAIL") === "other", "models.mjs: code failure must not be treated as quota");
  assert(models.classifyFailure("context_length_exceeded") === "context", "models.mjs: context classification is broken");
  assert(problems.length === 0, problems.slice(0, 12).join("; "));
  return `${models.DEFAULT_MODELS.length} models, ${models.MODEL_ROLES.length} roles`;
}

async function checkScarceAgent() {
  const agent = read(".opencode/agents/fa-scarce.md");
  const runner = read("scripts/fa/runner.mjs");
  assert(/^steps: 1$/m.test(agent), "fa-scarce agent must make at most one model turn");
  assert(/action:\s*"\*"\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*deny/.test(agent), "fa-scarce agent must not have tool access");
  assert(runner.includes('model.scarce === true ? "fa-scarce" : agent'), "runner does not select the single-turn agent for explicitly scarce models");
  return "one-turn model profile";
}

async function checkPrompts() {
  const moduleUrl = `${pathToFileURL(join(ROOT, "scripts/fa/prompts.mjs")).href}?verify=${Date.now()}`;
  const prompts = await import(moduleUrl);
  const problems = prompts.validatePrompts();
  assert(problems.length === 0, problems.join("; "));
  for (const [name, version] of Object.entries(prompts.PROMPT_VERSIONS)) {
    if (!/^[a-z-]+-v\d+$/.test(version)) problems.push(`${name}: invalid version ${version}`);
  }
  assert(problems.length === 0, problems.join("; "));
  return `${Object.keys(prompts.PROMPT_VERSIONS).length} prompts`;
}

async function checkHarnessModules() {
  const modules = [
    ["router.mjs", ["ModelSession", "RateLedger", "Breaker", "roleCandidates"]],
    ["telemetry.mjs", ["recordTrace", "flushTelemetry", "buildOtlpPayload", "createOtlpSpan"]],
    ["context.mjs", ["buildContext", "contextForTask"]],
    ["memory.mjs", ["loadMemory", "addMemory", "searchMemory"]],
    ["state.mjs", ["createRunState", "saveCheckpoint", "canResume"]],
    ["ui.mjs", ["runUiSmoke", "findChrome"]],
    ["mcp-server.mjs", ["TOOLS", "callTool"]],
    ["doctor.mjs", ["preflight", "probeModels"]]
  ];
  const problems = [];
  for (const [file, exports] of modules) {
    const moduleUrl = `${pathToFileURL(join(ROOT, "scripts/fa", file)).href}?verify=${Date.now()}`;
    const mod = await import(moduleUrl);
    for (const name of exports) {
      if (!(name in mod)) problems.push(`${file}: missing export ${name}`);
    }
  }
  assert(problems.length === 0, problems.join("; "));
  return `${modules.length} modules`;
}

async function checkUiContract() {
  const pkg = JSON.parse(read("package.json"));
  const problems = [];
  if (!pkg.scripts?.["verify:ui"]) problems.push("package.json: scripts.verify:ui is missing");
  if (!pkg.scripts?.["fa:doctor"]) problems.push("package.json: scripts.fa:doctor is missing");
  if (!pkg.scripts?.["fa:selftest"]) problems.push("package.json: scripts.fa:selftest is missing");
  if (!pkg.scripts?.["fa:mcp"]) problems.push("package.json: scripts.fa:mcp is missing");
  const ui = read("scripts/fa/ui.mjs");
  if (!ui.includes("Input.dispatchMouseEvent")) problems.push("ui.mjs: clicks must go through CDP input, not just DOM .click()");
  if (!ui.includes("setViewport")) problems.push("ui.mjs: viewport checks are missing");
  const prompt = read("scripts/fa/prompts.mjs");
  if (!prompt.includes("npm run verify:ui")) problems.push("prompts: verify:ui is not mentioned");
  assert(problems.length === 0, problems.join("; "));
  return "ok";
}

async function checkSelftest() {
  const file = join(ROOT, "scripts/fa/selftest.mjs");
  if (!existsSync(file)) throw new Error("scripts/fa/selftest.mjs is missing");
  const result = spawnSync(process.execPath, [file, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  assert(result.status === 0 && parsed?.ok, `selftest failed: ${(result.stderr || result.stdout || "").slice(0, 800)}`);
  return `${parsed.checks?.length || 0} checks`;
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
  for (const script of ["verify:json", "verify:ui", "fa", "fa:doctor", "fa:preflight", "fa:status", "fa:queue", "fa:selftest", "fa:mcp"]) {
    assert(pkg.scripts[script], `package.json: scripts.${script} is missing`);
  }
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
    const protectedFiles = files.filter(
      (file) => isProtected(file) && !(ALLOW_TASKS && file === "TASKS.md")
    );
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
  await run("models.registry", checkModelRegistry);
  await run("models.scarce-profile", checkScarceAgent);
  await run("prompts.contract", checkPrompts);
  await run("harness.modules", checkHarnessModules);
  await run("ui.contract", checkUiContract);
  await run("harness.selftest", checkSelftest);
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
