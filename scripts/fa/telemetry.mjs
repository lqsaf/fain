import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const spans = [];
const openModelSpans = new Map();
const openToolSpans = new Map();
const OTEL_SCOPE = "lqsaf/fain";

function modelCallKey(record) {
  return [record.correlationId, record.task || "", record.phase || "", record.model || ""].join(":");
}

function toolCallKey(record) {
  return [record.correlationId, record.task || "", record.toolCallId || ""].join(":");
}

function attribute(key, value) {
  if (value === undefined || value === null || value === "") return null;
  const typedValue =
    typeof value === "boolean"
      ? { boolValue: value }
      : typeof value === "number" && Number.isFinite(value)
        ? Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value }
        : { stringValue: String(value) };
  return { key, value: typedValue };
}

function recordAttributes(record, status) {
  return [
    attribute("fa.event", record.event),
    attribute("fa.run_id", record.runId),
    attribute("fa.task_id", record.task),
    attribute("fa.correlation_id", record.correlationId),
    attribute("fa.phase", record.phase),
    attribute("fa.model", record.model),
    attribute("fa.provider", String(record.model || "").split("/")[0]),
    attribute("fa.etclovg_layer", record.layer),
    attribute("fa.agent", record.agent),
    attribute("fa.status", status),
    attribute("fa.duration_ms", record.durationMs),
    attribute("fa.tokens", record.tokens),
    attribute("fa.failure_category", record.category),
    attribute("fa.tool", record.tool),
    attribute("fa.tool_call_id", record.toolCallId),
    attribute("fa.sandbox", record.sandbox),
    attribute("fa.exit_code", record.exitCode),
    attribute("fa.cost", record.cost)
  ].filter(Boolean);
}

function timestampNs(value) {
  const milliseconds = Date.parse(value);
  return String(BigInt(Number.isFinite(milliseconds) ? milliseconds : Date.now()) * 1_000_000n);
}

export function createOtlpSpan(record, startRecord = record, status = "ok") {
  const startTimeUnixNano = timestampNs(startRecord.at);
  const endTime = timestampNs(record.at);
  const start = BigInt(startTimeUnixNano);
  const end = BigInt(endTime);
  return {
    traceId: startRecord.traceId || record.traceId,
    spanId: startRecord.spanId || record.spanId,
    name:
      startRecord === record
        ? String(record.event || "fa.event")
        : String(startRecord.event || "").startsWith("tool.")
          ? `tool ${record.tool || startRecord.tool || "call"}`
          : `model ${record.phase || "call"}`,
    kind: 1,
    startTimeUnixNano,
    endTimeUnixNano: String(end > start ? end : start + 1n),
    attributes: recordAttributes(record, status),
    status: status === "error" ? { code: 2 } : { code: 1 }
  };
}

function addSpan(record, startRecord = record, status = "ok") {
  spans.push(createOtlpSpan(record, startRecord, status));
}

export function recordTrace(record) {
  const event = String(record.event || "");
  const toolKey = toolCallKey(record);
  if (event === "tool.start") {
    openToolSpans.set(toolKey, record);
    return;
  }
  if (event === "tool.done" || event === "tool.error") {
    const start = openToolSpans.get(toolKey);
    if (start) {
      addSpan(record, start, event === "tool.done" ? "ok" : "error");
      openToolSpans.delete(toolKey);
      return;
    }
  }

  const key = modelCallKey(record);
  if (event === "model.start") {
    openModelSpans.set(key, record);
    return;
  }

  if (
    event === "model.done" ||
    event === "model.error" ||
    event === "model.infra" ||
    event === "model.fallback" ||
    event === "model.key_fallback"
  ) {
    const start = openModelSpans.get(key);
    if (start) {
      addSpan(record, start, event === "model.done" ? "ok" : "error");
      openModelSpans.delete(key);
      return;
    }
  }

  const failed = /(?:error|failed|fatal|budget_exhausted|fallback)/i.test(event);
  addSpan(record, record, failed ? "error" : "ok");
}

export function buildOtlpPayload({ serviceName = "fain", environment = "" } = {}) {
  const resourceAttributes = [
    attribute("service.name", serviceName),
    attribute("service.version", "1"),
    attribute("deployment.environment", environment)
  ].filter(Boolean);
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ scope: { name: OTEL_SCOPE }, spans: [...spans] }]
      }
    ]
  };
}

function endpointFrom(env) {
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || "").replace(/\/+$/, "");
  return base ? `${base}/v1/traces` : "";
}

function headersFrom(env) {
  const headers = { "content-type": "application/json" };
  for (const pair of String(env.OTEL_EXPORTER_OTLP_HEADERS || "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    headers[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return headers;
}

export async function flushTelemetry({ runDir = "", env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const now = new Date().toISOString();
  for (const start of openModelSpans.values()) {
    addSpan({ ...start, event: "model.unfinished", at: now }, start, "error");
  }
  openModelSpans.clear();
  for (const start of openToolSpans.values()) {
    addSpan({ ...start, event: "tool.unfinished", at: now }, start, "error");
  }
  openToolSpans.clear();

  const payload = buildOtlpPayload({
    environment: env.GITHUB_ACTIONS ? "github-actions" : env.CI ? "ci" : "local"
  });
  if (runDir) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "traces.otlp.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  const endpoint = endpointFrom(env);
  if (!endpoint) return { spans: spans.length, written: Boolean(runDir), exported: false };
  if (typeof fetchImpl !== "function") throw new Error("OpenTelemetry endpoint is set but fetch is unavailable");

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: headersFrom(env),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      console.error(`OpenTelemetry export failed: HTTP ${response.status}`);
      return { spans: spans.length, written: Boolean(runDir), exported: false, status: response.status };
    }
    return { spans: spans.length, written: Boolean(runDir), exported: true };
  } catch (error) {
    console.error(`OpenTelemetry export failed: ${error.message}`);
    return { spans: spans.length, written: Boolean(runDir), exported: false, reason: error.message };
  }
}
