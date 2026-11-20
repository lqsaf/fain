#!/usr/bin/env node
// CLI браузерной проверки. Используется и человеком, и агентом:
//   npm run verify:ui [-- --task T04 --json]
// Без Chrome проверка помечается skipped, если не передан --require.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./config.mjs";
import { findTask, readQueue } from "./queue.mjs";
import { runUiSmoke, uiSummary } from "./ui.mjs";

function parseArgs(argv) {
  const out = { task: "", json: false, require: false, out: join(ROOT, "fa/tmp/ui") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task") out.task = argv[++i] || "";
    else if (arg === "--json") out.json = true;
    else if (arg === "--require") out.require = true;
    else if (arg === "--out") out.out = argv[++i] || out.out;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/fa/ui-smoke.mjs [--task Txx] [--json] [--require] [--out dir]");
    return;
  }

  const task = options.task ? findTask(readQueue(), options.task) : null;
  if (options.task && !task) {
    console.error(`task ${options.task} not found`);
    process.exitCode = 2;
    return;
  }

  const result = await runUiSmoke({ task, outDir: options.out, requireBrowser: options.require });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(uiSummary(result));
    for (const check of result.checks) {
      console.log(`${check.status === "ok" ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    for (const error of result.errors) console.error(`\nFAIL ${error}`);
    if (result.screenshots?.length) console.log(`\nScreenshots: ${result.screenshots.join(", ")}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`ui smoke failed: ${error.stack || error.message}`);
    process.exitCode = 2;
  });
}
