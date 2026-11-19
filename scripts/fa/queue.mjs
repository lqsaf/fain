// Parser and editor for the human-owned task queue in TASKS.md.
// The queue format is intentionally boring so both humans and scripts can edit it.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const QUEUE_FILE = "TASKS.md";
export const STATUS_CHARS = { todo: " ", claimed: "~", blocked: "!", done: "x" };
export const CHAR_STATUS = { " ": "todo", "~": "claimed", "!": "blocked", x: "done" };

const HEADING_RE = /^## \[([ ~!x])\] (T\d{2,})\s*[·:—-]\s*(.+)$/u;
const FIELD_RE = /^- ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/;

export function queuePath(root = ROOT) {
  return join(root, QUEUE_FILE);
}

export function readQueue(root = ROOT) {
  return parseQueue(readFileSync(queuePath(root), "utf8"));
}

export function writeQueue(text, root = ROOT) {
  writeFileSync(queuePath(root), text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

export function parseQueue(text) {
  const lines = text.split(/\r?\n/);
  const tasks = [];
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(HEADING_RE);
    if (match) {
      if (current) current.endLine = i;
      current = {
        statusChar: match[1],
        status: CHAR_STATUS[match[1]],
        id: match[2],
        title: match[3].trim(),
        headingLine: i,
        endLine: lines.length,
        body: []
      };
      tasks.push(current);
    } else if (current) {
      current.body.push(lines[i]);
    }
  }

  for (const task of tasks) {
    task.fields = parseFields(task.body);
    task.area = task.fields.area || "";
    task.priority = task.fields.priority || "normal";
    task.files = splitList(task.fields.files);
    task.context = splitList(task.fields.context);
    task.dependsOn = splitList(task.fields.depends_on);
    task.verify = (task.fields.verify || "node scripts/verify.mjs").trim();
    task.acceptance = (task.fields.acceptance || "").trim();
    task.needs = (task.fields.needs || "").trim();
    task.review = (task.fields.review || "optional").trim();
    task.attempts = Number.parseInt(task.fields.attempts || "0", 10) || 0;
  }

  return tasks;
}

export function parseFields(body) {
  const fields = {};
  for (let i = 0; i < body.length; i += 1) {
    const match = body[i].match(FIELD_RE);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (value === "|" || value === ">") {
      const buffer = [];
      let j = i + 1;
      while (j < body.length) {
        const line = body[j];
        if (line.trim() === "") {
          buffer.push("");
          j += 1;
          continue;
        }
        if (!/^\s+/.test(line)) break;
        buffer.push(line.replace(/^ {2,4}/, ""));
        j += 1;
      }
      value = buffer.join("\n").trim();
      i = j - 1;
    }

    fields[key] = value;
  }
  return fields;
}

export function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function selectNext(tasks, options = {}) {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  const order = { high: 0, normal: 1, low: 2 };
  const candidates = tasks.filter((task) => {
    if (options.includeBlocked && task.status === "blocked") return true;
    if (task.status !== "todo") return false;
    if (task.needs) return false;
    if (task.dependsOn.some((id) => !done.has(id))) return false;
    return true;
  });

  return candidates.sort((a, b) => {
    const byPriority = (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
    return byPriority || a.id.localeCompare(b.id);
  })[0] || null;
}

export function findTask(tasks, id) {
  return tasks.find((task) => task.id === id) || null;
}

/**
 * Update one task block. `patch` supports:
 *   status, fields (set/replace), remove (field names), extra (raw lines).
 */
export function updateTask(text, id, patch) {
  const tasks = parseQueue(text);
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new Error(`Task ${id} not found in queue`);

  const lines = text.split(/\r?\n/);
  const statusChar = patch.status ? STATUS_CHARS[patch.status] : task.statusChar;
  const heading = `## [${statusChar}] ${task.id} · ${task.title}`;
  let body = lines.slice(task.headingLine + 1, task.endLine);

  if (patch.remove) {
    body = body.filter((line) => !patch.remove.some((key) => line.startsWith(`- ${key}:`)));
  }

  if (patch.fields) {
    for (const [key, value] of Object.entries(patch.fields)) {
      const prefix = `- ${key}:`;
      const index = body.findIndex((line) => line.startsWith(prefix));
      const line = `${prefix} ${String(value).replace(/\s+/g, " ").trim()}`;
      if (index >= 0) body[index] = line;
      else body.push(line);
    }
  }

  if (patch.extra && patch.extra.length > 0) {
    body.push(...patch.extra);
  }

  const nextLines = [...lines.slice(0, task.headingLine), heading, ...body, ...lines.slice(task.endLine)];
  return nextLines.join("\n");
}

export function markClaimed(text, id, fields = {}) {
  return updateTask(text, id, {
    status: "claimed",
    remove: ["claimed"],
    fields,
    extra: [`- claimed: ${new Date().toISOString()}`]
  });
}

export function markDone(text, id, note) {
  const cleaned = updateTask(text, id, {
    status: "done",
    remove: ["done", "blocked", "claimed", "last_error"],
    extra: [`- done: ${new Date().toISOString()}${note ? ` · ${note}` : ""}`]
  });
  return cleaned;
}

export function markBlocked(text, id, reason) {
  return updateTask(text, id, {
    status: "blocked",
    remove: ["done", "blocked", "claimed"],
    extra: [`- blocked: ${new Date().toISOString()} · ${String(reason).replace(/\s+/g, " ").slice(0, 500)}`]
  });
}

export function markTodo(text, id, fields = {}) {
  return updateTask(text, id, {
    status: "todo",
    remove: ["claimed"],
    fields
  });
}

export function resetStaleClaims(text) {
  let next = text;
  for (const task of parseQueue(text)) {
    if (task.status !== "claimed") continue;
    next = updateTask(next, task.id, {
      status: "todo",
      remove: ["claimed"],
      extra: [`- recovered: ${new Date().toISOString()} · stale claim reset`]
    });
  }
  return next;
}

const QUOTA_BLOCK_RE = /quota|rate[\s_-]?limit|too many requests|resource[_\s-]?exhausted|\b429\b/i;

function isQuotaBlock(task) {
  return task.status === "blocked" && QUOTA_BLOCK_RE.test(task.fields?.blocked || "");
}

/**
 * Задача, которая станет runnable после восстановления очереди: stale claim
 * или блок из-за временной квоты провайдера.
 */
export function recoverableTasks(tasks) {
  return tasks.filter((task) => task.status === "claimed" || isQuotaBlock(task));
}

/**
 * Квота провайдера — временная инфра-ошибка, а не свойство задачи.
 * Такие блоки снимаются автоматически; причина остаётся в истории `recovered`.
 */
export function resetQuotaBlocks(text) {
  let next = text;
  for (const task of parseQueue(text)) {
    if (!isQuotaBlock(task)) continue;
    next = updateTask(next, task.id, {
      status: "todo",
      remove: ["blocked", "claimed"],
      extra: [`- recovered: ${new Date().toISOString()} · quota block reset`]
    });
  }
  return next;
}

export function queueStats(tasks) {
  return {
    total: tasks.length,
    todo: tasks.filter((task) => task.status === "todo").length,
    claimed: tasks.filter((task) => task.status === "claimed").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    done: tasks.filter((task) => task.status === "done").length,
    waiting: tasks.filter((task) => task.status === "todo" && task.needs).length
  };
}

function printList(tasks) {
  const rows = tasks.map((task) => ({
    status: task.status === "todo" ? "[ ]" : task.status === "claimed" ? "[~]" : task.status === "blocked" ? "[!]" : "[x]",
    id: task.id,
    priority: task.priority,
    area: task.area,
    title: task.title,
    note: task.needs ? `needs: ${task.needs}` : task.status === "blocked" ? task.fields.blocked || "" : ""
  }));

  const widths = {
    status: 4,
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    priority: Math.max(8, ...rows.map((row) => row.priority.length)),
    area: Math.max(4, ...rows.map((row) => row.area.length))
  };

  for (const row of rows) {
    const line = [
      row.status.padEnd(widths.status),
      row.id.padEnd(widths.id),
      row.priority.padEnd(widths.priority),
      row.area.padEnd(widths.area),
      row.title,
      row.note ? `  (${row.note})` : ""
    ].join("  ");
    console.log(line.trimEnd());
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const tasks = readQueue();
  const command = process.argv[2] || "list";
  if (command === "json") {
    console.log(JSON.stringify(tasks, null, 2));
  } else if (command === "stats") {
    console.log(JSON.stringify(queueStats(tasks), null, 2));
  } else if (command === "has-work") {
    const next = selectNext(tasks);
    const recoverable = recoverableTasks(tasks);
    if (next) {
      console.log(next.id);
    } else if (recoverable.length > 0) {
      // Запуск нужен, чтобы снять stale claim или quota-блок.
      console.log(`recovery: ${recoverable.map((task) => task.id).join(",")}`);
    } else {
      console.error("no runnable tasks");
      process.exitCode = 3;
    }
  } else {
    printList(tasks);
  }
}
