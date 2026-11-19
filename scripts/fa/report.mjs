// Отчёты для человека: STATUS.md, тело PR и GitHub Summary.
// Никаких секретов и тел статей: только очередь, пути, числа и причины.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS, ensureDir } from "./config.mjs";
import { modelLabel } from "./models.mjs";
import { readQueue, queueStats } from "./queue.mjs";

const STATUS_ICON = { todo: "[ ]", claimed: "[~]", blocked: "[!]", done: "[x]" };

export function readSummary(file = join(PATHS.logs, "latest.json")) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function queueTable(tasks) {
  const rows = tasks.map((task) => {
    const icon = STATUS_ICON[task.status] || "[?]";
    const note = task.needs
      ? `needs: ${task.needs}`
      : task.status === "blocked"
        ? task.fields.blocked || ""
        : task.status === "done"
          ? task.fields.done || ""
          : "";
    return `| ${icon} | ${task.id} | ${task.priority} | ${task.area} | ${task.title} | ${note.replace(/\|/g, "\\|")} |`;
  });

  return [
    "| | ID | Приоритет | Область | Задача | Примечание |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

export function statusMarkdown(tasks, summary, meta = {}) {
  const stats = queueStats(tasks);
  const model = meta.model || summary?.model || modelLabel();
  const lines = [
    "# FA status",
    "",
    `Обновлено: ${new Date().toISOString()}`,
    `Модель: \`${model}\``,
    "",
    "## Очередь",
    "",
    `Всего: **${stats.total}** · todo: **${stats.todo}** · claimed: **${stats.claimed}** · blocked: **${stats.blocked}** · done: **${stats.done}** · ждут владельца: **${stats.waiting}**`,
    "",
    queueTable(tasks)
  ];

  if (summary) {
    lines.push(
      "",
      "## Последний запуск",
      "",
      `- Run: \`${summary.runId || "unknown"}\``,
      `- Итог: **${summary.ok ? "ok" : "failed"}**`,
      `- Причина остановки: \`${summary.stopReason || "unknown"}\``,
      `- Задач выполнено: ${summary.tasksDone ?? 0}`,
      `- Задач заблокировано: ${summary.tasksBlocked ?? 0}`,
      `- Модель: ${summary.model || "n/a"}, fallback: ${summary.modelFallbacks ?? 0}`,
      `- Токены: ${summary.tokens?.total ?? 0}`,
      `- Длительность: ${Math.round((summary.durationMs || 0) / 1000)} s`
    );

    if (Array.isArray(summary.tasks) && summary.tasks.length > 0) {
      lines.push("", "| Задача | Итог | Попытки | Файлы | Токены |", "| --- | --- | --- | --- | --- |");
      for (const task of summary.tasks) {
        lines.push(
          `| ${task.id} | ${task.result} | ${task.attempts} | ${(task.files || []).join(", ") || "—"} | ${task.tokens ?? 0} |`
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export function prBody(tasks, summary, meta = {}) {
  const stats = queueStats(tasks);
  const model = meta.model || summary?.model || modelLabel();
  const header = [
    "## FA — free agent",
    "",
    "Автоматический PR. Коммиты делает оркестратор, merge — человек.",
    "",
    `Модель: \`${model}\` · задач: **${stats.done}/${stats.total}** · todo: **${stats.todo}** · blocked: **${stats.blocked}**`,
    ""
  ];

  if (summary) {
    header.push(
      "### Последний запуск",
      "",
      `- \`${summary.runId || "unknown"}\` → **${summary.ok ? "ok" : "failed"}** (${summary.stopReason || "unknown"})`,
      `- Выполнено: ${summary.tasksDone ?? 0}, заблокировано: ${summary.tasksBlocked ?? 0}`,
      `- Модель: ${summary.model || "n/a"}, fallback: ${summary.modelFallbacks ?? 0}`,
      `- Токены: ${summary.tokens?.total ?? 0}, длительность: ${Math.round((summary.durationMs || 0) / 1000)} s`,
      ""
    );
  }

  return `${header.join("\n")}${queueTable(tasks)}\n\n---\n\nПроверки: \`npm run verify\` + \`fa-verify\`. Merge только после ревью человеком.\n`;
}

function main() {
  const args = process.argv.slice(2);
  const tasks = readQueue();
  const summary = readSummary(process.env.FA_SUMMARY || undefined);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ stats: queueStats(tasks), tasks, summary }, null, 2));
    return;
  }

  if (args.includes("--pr-body")) {
    process.stdout.write(prBody(tasks, summary));
    return;
  }

  const markdown = statusMarkdown(tasks, summary);

  if (args.includes("--github-summary") && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (args.includes("--write")) {
    ensureDir(PATHS.logs);
    writeFileSync(join(PATHS.logs, "STATUS.md"), markdown, "utf8");
  }

  process.stdout.write(markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`report failed: ${error.message}`);
    process.exitCode = 2;
  }
}
