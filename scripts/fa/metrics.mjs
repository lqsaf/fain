// Разбор JSONL-событий OpenCode. Схема событий может меняться, поэтому
// парсер ищет поля рекурсивно и деградирует, но не падает.

import { readFileSync } from "node:fs";

export function parseJsonlText(text) {
  const events = [];
  const badLines = [];

  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      badLines.push(trimmed.slice(0, 200));
    }
  }

  return { events, badLines };
}

export function readJsonl(file) {
  try {
    return parseJsonlText(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], badLines: [] };
    throw error;
  }
}

function walk(value, visitor, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return;
  visitor(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walk(child, visitor, depth + 1);
  }
}

function addTokens(tokens, target) {
  if (!tokens || typeof tokens !== "object") return;
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = (target[key] || 0) + value;
    } else if (value && typeof value === "object") {
      addTokens(value, target);
    }
  }
}

function extractTokens(event) {
  const tokens = {};
  walk(event, (node) => {
    if (node.tokens && typeof node.tokens === "object") addTokens(node.tokens, tokens);
  });
  return tokens;
}

function extractCost(event) {
  let cost = 0;
  walk(event, (node) => {
    if (typeof node.cost === "number" && Number.isFinite(node.cost)) cost += node.cost;
  });
  return cost;
}

function eventType(event) {
  return String(event.type || event.part?.type || "");
}

function extractTool(event) {
  const part = event.part || {};
  const tool = event.tool || part.tool || (part.type === "tool" ? part.tool : "") || "";
  if (!tool) return null;
  const input = event.input || part.state?.input || part.input || {};
  return { tool: String(tool), input };
}

function isError(event) {
  const part = event.part || {};
  if (event.error) return true;
  if (part.error) return true;
  if (part.state?.status === "error") return true;
  const type = eventType(event);
  return /error|failed|aborted/i.test(type);
}

export function analyzeEvents(events) {
  const tools = {};
  const calls = [];
  const tokens = {};
  let cost = 0;
  let errors = 0;
  let stepStarts = 0;
  let textBytes = 0;

  for (const event of events) {
    const type = eventType(event);
    if (/step[_-]?start/i.test(type)) stepStarts += 1;

    if (isError(event)) errors += 1;

    const call = extractTool(event);
    if (call) {
      const tool = call.tool || "unknown";
      tools[tool] = (tools[tool] || 0) + 1;
      let signature;
      try {
        signature = `${tool}:${JSON.stringify(call.input).slice(0, 500)}`;
      } catch {
        signature = `${tool}:unserializable`;
      }
      calls.push(signature);
    }

    addTokens(extractTokens(event), tokens);
    cost += extractCost(event);

    const text = event.text || event.part?.text;
    if (typeof text === "string") textBytes += text.length;
  }

  const tokenTotal =
    (tokens.input || 0) +
    (tokens.output || 0) +
    (tokens.reasoning || 0) +
    (tokens.cache?.read || 0) +
    (tokens.cache?.write || 0);

  let maxRepeat = 0;
  let run = 0;
  let previous = "";
  const repeated = [];
  for (const signature of calls) {
    if (signature === previous) run += 1;
    else {
      run = 1;
      previous = signature;
    }
    if (run > maxRepeat) maxRepeat = run;
    if (run === 3) repeated.push(signature.split(":")[0]);
  }

  const toolErrors = errors;
  const toolCalls = calls.length;

  return {
    events: events.length,
    steps: stepStarts || (toolCalls > 0 ? toolCalls + 1 : events.length > 0 ? 1 : 0),
    toolCalls,
    tools,
    errors: toolErrors,
    toolErrorRate: toolCalls > 0 ? Number((toolErrors / Math.max(toolCalls, events.length)).toFixed(3)) : 0,
    tokens,
    tokenTotal,
    cost: Number(cost.toFixed(6)),
    textBytes,
    repeatedCalls: { maxRepeat, tools: [...new Set(repeated)] }
  };
}

export function analyzeFile(file) {
  const { events, badLines } = readJsonl(file);
  return {
    file,
    badLines: badLines.length,
    ...analyzeEvents(events)
  };
}

export function flags(metrics, { changedFiles = 0, tokenBudget = Infinity } = {}) {
  const out = [];
  if (metrics.repeatedCalls.maxRepeat >= 3) out.push("repeated_calls");
  if (metrics.toolCalls > 40 && changedFiles === 0) out.push("no_progress");
  if (metrics.toolCalls > 0 && metrics.toolErrorRate > 0.5) out.push("tool_errors");
  if (metrics.tokenTotal > tokenBudget) out.push("token_budget");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/fa/metrics.mjs <events.jsonl>");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(analyzeFile(file), null, 2));
    } catch (error) {
      console.error(`metrics failed: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
