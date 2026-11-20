// Память FA: уроки прошлых запусков, которые переживают сессию.
// Хранится в fa/memory (gitignored) и восстанавливается через actions/cache.
// Модель не пишет сюда напрямую: записи делает оркестратор из проверяемых фактов.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS, ROOT } from "./config.mjs";

const MAX_ENTRIES = Number(process.env.FA_MEMORY_MAX || 600);

export function memoryFile(root = ROOT) {
  return process.env.FA_MEMORY_FILE || join(root, "fa/memory/entries.jsonl");
}

function ensure(file) {
  mkdirSync(dirname(file), { recursive: true });
}

export function loadMemory({ file = memoryFile(), root = ROOT } = {}) {
  const path = file === memoryFile() ? memoryFile(root) : file;
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.text) entries.push(entry);
    } catch {
      // битая строка не должна ломать память
    }
  }
  return entries;
}

function atomicWrite(file, text) {
  ensure(file);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function saveMemory(entries, { file = memoryFile(), root = ROOT } = {}) {
  const path = file === memoryFile() ? memoryFile(root) : file;
  const compacted = entries.slice(-MAX_ENTRIES);
  atomicWrite(path, compacted.map((entry) => JSON.stringify(entry)).join("\n") + (compacted.length ? "\n" : ""));
  return compacted.length;
}

function clean(value, max = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function addMemory(entry, { file = memoryFile(), root = ROOT } = {}) {
  const record = {
    at: new Date().toISOString(),
    task: clean(entry.task, 20),
    area: clean(entry.area, 40),
    phase: clean(entry.phase, 40),
    kind: ["failure", "lesson", "decision", "success"].includes(entry.kind) ? entry.kind : "lesson",
    text: clean(entry.text),
    model: clean(entry.model, 120),
    fingerprint: clean(entry.fingerprint, 24),
    tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => clean(tag, 40)).slice(0, 10) : []
  };
  if (!record.text) return null;

  const path = file === memoryFile() ? memoryFile(root) : file;
  ensure(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");

  // Периодическая компакция: дешёвая, без похода в сеть.
  const entries = loadMemory({ file: path });
  if (entries.length > MAX_ENTRIES * 1.2) saveMemory(entries, { file: path });
  return record;
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-zа-я0-9_]+/u)
    .filter((token) => token.length >= 3);
}

export function searchMemory(query, { area = "", task = "", limit = 6, file = memoryFile(), root = ROOT } = {}) {
  const entries = loadMemory({ file, root });
  const queryTokens = [...new Set(tokens(`${query} ${area} ${task}`))];
  if (queryTokens.length === 0) return entries.slice(-limit).reverse();

  const now = Date.now();
  const scored = entries.map((entry) => {
    const haystack = tokens(`${entry.text} ${entry.area} ${entry.task} ${entry.phase} ${(entry.tags || []).join(" ")}`);
    const set = new Set(haystack);
    let score = queryTokens.reduce((sum, token) => sum + (set.has(token) ? 1 : 0), 0);
    if (area && entry.area === area) score += 2;
    if (task && entry.task === task) score += 3;
    const ageDays = (now - new Date(entry.at).getTime()) / 86_400_000;
    const recency = Math.max(0, 1 - ageDays / 90);
    return { entry, score, recency };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.recency - a.recency || String(b.entry.at).localeCompare(String(a.entry.at)))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function failureFingerprint(reason) {
  const normalized = clean(reason, 1200)
    .toLowerCase()
    .replace(/\bt\d+\b/gi, "<task>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/(?:[a-z]:)?[\\/][^\s:]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function repeatedFailureTrend(entries, fingerprint, { minOccurrences = 3, minTasks = 2 } = {}) {
  const cutoff = Date.now() - 90 * 86_400_000;
  const matches = entries.filter(
    (entry) =>
      entry.kind === "failure" &&
      entry.fingerprint === fingerprint &&
      new Date(entry.at).getTime() >= cutoff
  );
  const tasks = [...new Set(matches.map((entry) => entry.task).filter(Boolean))];
  return {
    repeated: matches.length >= minOccurrences && tasks.length >= minTasks,
    occurrences: matches.length,
    tasks,
    entries: matches.slice(-5)
  };
}

export function recordFailure({ task, area, phase, reason, model, tags = [], fingerprint = "" }, options = {}) {
  return addMemory(
    {
      task,
      area,
      phase,
      kind: "failure",
      model,
      fingerprint: fingerprint || failureFingerprint(reason),
      text: `Провал: ${clean(reason, 900)}`,
      tags: ["failure", ...tags]
    },
    options
  );
}

export function recordLesson({ task, area, phase, text, model, tags = [] }, options = {}) {
  return addMemory({ task, area, phase, kind: "lesson", text, model, tags }, options);
}

export function memoryStats(entries = loadMemory()) {
  const byKind = {};
  const byArea = {};
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    byArea[entry.area || "unknown"] = (byArea[entry.area || "unknown"] || 0) + 1;
  }
  return { total: entries.length, byKind, byArea, file: memoryFile() };
}

function parseArgs(argv) {
  const out = { action: "list", query: "", task: "", area: "", text: "", kind: "lesson", json: false, limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["list", "search", "add", "stats"].includes(arg)) out.action = arg;
    else if (arg === "--query") out.query = argv[++i] || "";
    else if (arg === "--task") out.task = argv[++i] || "";
    else if (arg === "--area") out.area = argv[++i] || "";
    else if (arg === "--text") out.text = argv[++i] || "";
    else if (arg === "--kind") out.kind = argv[++i] || "lesson";
    else if (arg === "--limit") out.limit = Number(argv[++i]) || 10;
    else if (arg === "--json") out.json = true;
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "add") {
    if (!options.text) {
      console.error("--text is required");
      process.exitCode = 2;
      return;
    }
    const entry = addMemory({
      task: options.task,
      area: options.area,
      kind: options.kind,
      text: options.text
    });
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  if (options.action === "stats") {
    const stats = memoryStats();
    console.log(options.json ? JSON.stringify(stats, null, 2) : `memory: ${stats.total} entries (${stats.file})`);
    return;
  }

  const entries =
    options.action === "search"
      ? searchMemory(options.query, { task: options.task, area: options.area, limit: options.limit })
      : loadMemory().slice(-options.limit).reverse();

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.at} [${entry.kind}] ${entry.task} ${entry.phase || ""} — ${entry.text}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`memory failed: ${error.message}`);
    process.exitCode = 2;
  }
}
