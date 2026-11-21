// Исполнитель одной фазы: запускает `opencode run` на модели, извлечённой
// router'ом, и переключается на следующую модель только при инфраструктурном
// отказе. Ошибки кода не тратят модели: они возвращаются оркестратору.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, OPENCODE_BIN, ROOT } from "./config.mjs";
import { classifyFailure, estimateTokens } from "./models.mjs";
import { estimatePhaseTokens } from "./router.mjs";
import { analyzeFile, parseJsonlText } from "./metrics.mjs";

function readSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function sanitize(value) {
  return String(value || "")
    .replace(/AIza[0-9A-Za-z_-]{35}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]");
}

export function extractText(stdoutFile) {
  const { events } = parseJsonlText(readSafe(stdoutFile));
  const parts = [];
  for (const event of events) {
    const text = event.text || event.part?.text || event.message?.text;
    if (typeof text === "string" && text.trim()) parts.push(text);
    if (typeof event.part?.state?.output === "string" && event.part?.type === "tool") {
      // Вывод инструментов не является ответом модели.
      continue;
    }
  }
  // Иногда одно и то же сообщение приходит несколькими событиями.
  const seen = new Set();
  return parts
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join("\n")
    .trim();
}

export function extractErrorDetail(stdoutFile, stderrFile) {
  const { events } = parseJsonlText(readSafe(stdoutFile));
  let jsonError = "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const error = event.error || event.part?.error;
    if (error || event.type === "error") {
      const category = error?.type || error?.name || "error";
      const message = error?.message || JSON.stringify(error || event);
      jsonError = `${category}: ${message}`;
      break;
    }
  }
  const stderr = readSafe(stderrFile)
    .split("\n")
    .filter(Boolean)
    .slice(-8)
    .join(" | ");
  return sanitize((jsonError || stderr || "no output").slice(0, 1200));
}

export function spawnOpencode({ args, env = process.env, cwd = ROOT, timeoutMs = 30 * 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE_BIN, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // уже завершился
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // уже завершился
        }
      }, 10_000).unref();
    }, timeoutMs);

    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, timedOut, spawnError: error, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        timedOut,
        spawnError: null,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString()
      });
    });
  });
}

function detectMarker(text, markers = []) {
  for (const marker of markers) {
    if (marker instanceof RegExp ? marker.test(text) : text.includes(marker)) return true;
  }
  return false;
}

function detectBlocked(text, reason) {
  const match = String(text || "").match(/(?:^|\n)\s*BLOCKED:\s*([^\n]+)/i);
  if (match) return match[1].trim();
  if (/\bBLOCKED\b/i.test(String(text || ""))) return "model reported BLOCKED without a reason";
  if (reason && /\bBLOCKED\b/i.test(reason)) return reason;
  return "";
}

function timestamp(value, fallback = new Date().toISOString()) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function recordToolSpans(stdoutFile, { taskId, role, model, log }) {
  const { events } = parseJsonlText(readSafe(stdoutFile));
  const opened = new Set();
  for (const [index, event] of events.entries()) {
    const part = event.part || {};
    const tool = String(event.tool || part.tool || "");
    if (!tool) continue;

    const state = part.state || event.state || {};
    const timing = state.time || part.time || event.time || {};
    const toolCallId = String(event.callID || part.callID || event.id || `${taskId}-${role}-${index}`);
    const startAt = timestamp(timing.start || event.startedAt || event.timestamp);
    const endValue = timing.end || event.endedAt || event.timestamp;
    const status = String(state.status || "").toLowerCase();
    const base = {
      task: taskId,
      phase: role,
      model,
      tool,
      toolCallId,
      sandbox: "opencode-policy"
    };

    if (!opened.has(toolCallId)) {
      log("tool.start", { ...base, at: startAt });
      opened.add(toolCallId);
    }

    if (status === "running" && !timing.end && !event.endedAt) continue;
    const endAt = timestamp(endValue, new Date(Date.parse(startAt) + 1).toISOString());
    const durationMs = Math.max(0, Date.parse(endAt) - Date.parse(startAt));
    log(status === "error" || status === "failed" ? "tool.error" : "tool.done", {
      ...base,
      at: endAt,
      durationMs,
      status: status === "error" || status === "failed" ? "error" : "ok"
    });
    opened.delete(toolCallId);
  }
}

/**
 * Запускает фазу с fallback по моделям роли.
 *
 * Возвращает kind:
 *  - ok       — exit 0 и найден ожидаемый маркер;
 *  - blocked  — модель явно сказала BLOCKED;
 *  - attempt  — exit 0, но маркер не найден (ошибка качества, не инфраструктуры);
 *  - infra    — spawn/timeout/падение процесса;
 *  - exhausted — все модели роли недоступны.
 */
export async function runPhase({
  session,
  role,
  agent,
  prompt,
  title,
  timeoutMs,
  runDir,
  fileBase,
  taskId = "",
  markers = [],
  avoidProvider = "",
  excludeModels = [],
  log = () => {},
  env = process.env,
  spawnImpl = spawnOpencode
}) {
  if (timeoutMs <= 0) {
    return { kind: "budget", reason: "run time budget exhausted before phase start", metrics: { tokenTotal: 0, cost: 0 }, model: "", fallbacks: 0 };
  }
  const contextTokens = estimateTokens(prompt.length);
  const estimate = estimatePhaseTokens(role, { contextTokens });
  const phaseDeadline = Date.now() + timeoutMs;
  const candidates = session.candidates(role, { avoidProvider, exclude: excludeModels });
  let fallbacks = 0;
  let lastReason = "no model available";
  let lastInfrastructure = null;
  let totalTokens = 0;
  let totalBudgetTokens = 0;
  let totalCost = 0;

  if (candidates.length === 0) {
    return { kind: "exhausted", reason: `no available model for role ${role}`, metrics: { tokenTotal: 0, cost: 0 }, model: "", fallbacks };
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const remainingMs = phaseDeadline - Date.now();
    if (remainingMs <= 0) {
      return {
        kind: lastInfrastructure ? "infra" : "budget",
        reason: lastInfrastructure?.reason || "phase time budget exhausted before model start",
        metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
        model: lastInfrastructure?.model || "",
        fallbacks,
        durationMs: Date.now() - (phaseDeadline - timeoutMs)
      };
    }

    const reserved = await session.reserve(role, {
      estimateTokens: estimate,
      maxWaitMs: Math.min(
        Number(env.FA_RATE_WAIT_MAX_SEC || 45) * 1000,
        Math.max(0, remainingMs - 1000)
      ),
      avoidProvider,
      exclude: [...excludeModels, ...candidates.slice(0, index).map((item) => item.id)]
    });
    if (!reserved.ok) {
      lastReason = reserved.reason;
      if (reserved.budgetExhausted) {
        return {
          kind: "budget",
          reason: reserved.reason,
          metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
          model: "",
          fallbacks
        };
      }
      if (lastInfrastructure) {
        return {
          kind: "infra",
          reason: `${lastInfrastructure.reason}; no fallback model available: ${reserved.reason}`,
          metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
          model: lastInfrastructure.model,
          fallbacks,
          durationMs: Date.now() - (phaseDeadline - timeoutMs)
        };
      }
      break;
    }

    const model = reserved.model;
    const fileSuffix = `${role}-${index + 1}`;
    const stdoutFile = join(runDir, `${fileBase}-${fileSuffix}.jsonl`);
    const stderrFile = join(runDir, `${fileBase}-${fileSuffix}.err.log`);
    writeFileSync(stdoutFile, "", "utf8");
    writeFileSync(stderrFile, "", "utf8");
    const selectedAgent = model.scarce === true ? "fa-scarce" : agent;
    const started = Date.now();
    const providerEnv = session.providerEnv(model, env);
    const remainingForModelMs = phaseDeadline - Date.now();
    if (remainingForModelMs <= 0) {
      session.release(reserved.reservation);
      return {
        kind: lastInfrastructure ? "infra" : "budget",
        reason: lastInfrastructure?.reason || "phase time budget exhausted before model start",
        metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
        model: lastInfrastructure?.model || "",
        fallbacks,
        durationMs: Date.now() - (phaseDeadline - timeoutMs)
      };
    }
    const modelBudgetMs = index + 1 < candidates.length
      ? Math.max(60_000, Math.floor(remainingForModelMs / 2))
      : remainingForModelMs;
    const modelTimeoutMs = Math.min(remainingForModelMs, LIMITS.modelTimeoutMs, modelBudgetMs);
    log("model.start", {
      task: taskId,
      phase: role,
      model: model.id,
      agent: selectedAgent,
      message: `${model.id} (${index + 1}/${candidates.length}, timeout ${Math.round(modelTimeoutMs / 1000)}s)${model.scarce === true ? " single-turn" : ""}`
    });
    const result = await spawnImpl({
      args: ["run", "--agent", selectedAgent, "--model", model.id, "--format", "json", "--auto", "--title", title, prompt],
      timeoutMs: modelTimeoutMs,
      env: providerEnv
    });
    writeFileSync(stdoutFile, result.stdout || "", "utf8");
    writeFileSync(stderrFile, result.stderr || "", "utf8");
    recordToolSpans(stdoutFile, { taskId, role, model: model.id, log });

    const metrics = analyzeFile(stdoutFile);
    totalTokens += metrics.tokenTotal;
    totalBudgetTokens += metrics.tokenTotal > 0 ? metrics.tokenTotal : estimate;
    totalCost += metrics.cost || 0;
    const durationMs = Date.now() - started;

    if (result.spawnError || result.timedOut) {
      const reason = result.spawnError?.message || `timeout after ${Math.round(modelTimeoutMs / 1000)}s`;
      session.failover(reserved.reservation, "unavailable", reason, metrics.tokenTotal);
      log("model.infra", { task: taskId, phase: role, model: model.id, message: reason });
      lastReason = reason;
      lastInfrastructure = { reason, model: model.id, stdoutFile, stderrFile, durationMs };
      if (index + 1 >= candidates.length) {
        return {
          kind: "infra",
          reason,
          metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
          model: model.id,
          stdoutFile,
          stderrFile,
          durationMs,
          fallbacks
        };
      }
      fallbacks += 1;
      const failureType = result.timedOut ? "timeout" : "spawn error";
      log("model.fallback", {
        task: taskId,
        phase: role,
        model: model.id,
        message: `${model.id} -> ${candidates[index + 1].id} (${failureType}): ${sanitize(reason).slice(0, 200)}`
      });
      continue;
    }

    if (result.code !== 0) {
      const detail = extractErrorDetail(stdoutFile, stderrFile);
      const category = classifyFailure(detail);
      if (category === "quota" && session.rotateCredential(model, env)) {
        fallbacks += 1;
        lastReason = detail;
        session.settle(reserved.reservation, { actualTokens: metrics.tokenTotal });
        log("model.key_fallback", {
          task: taskId,
          phase: role,
          model: model.id,
          message: `${model.id}: quota on provider key; retrying with next configured key`
        });
        index -= 1;
        continue;
      }
      if (category !== "other" && index + 1 < candidates.length) {
        fallbacks += 1;
        lastReason = detail;
        session.failover(reserved.reservation, category, detail);
        log("model.fallback", {
          task: taskId,
          phase: role,
          model: model.id,
          message: `${model.id} -> ${candidates[index + 1].id} (${category}): ${sanitize(detail).slice(0, 200)}`
        });
        continue;
      }
      session.failover(reserved.reservation, category, detail);
      log("model.error", {
        task: taskId,
        phase: role,
        model: model.id,
        category,
        durationMs,
        tokens: metrics.tokenTotal,
        message: "model call failed without a retryable fallback"
      });
      return {
        kind: category === "other" ? "attempt" : "exhausted",
        reason: `opencode exit ${result.code}: ${detail}`,
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
        model: model.id,
        stdoutFile,
        stderrFile,
        durationMs,
        fallbacks
      };
    }

    const text = extractText(stdoutFile);
    session.settle(reserved.reservation, { actualTokens: metrics.tokenTotal });
    log("model.done", { task: taskId, phase: role, model: model.id, message: `${metrics.tokenTotal} tokens, ${Math.round(durationMs / 1000)}s` });

    const blocked = detectBlocked(text, extractErrorDetail(stdoutFile, stderrFile));
    if (blocked) {
      return {
        kind: "blocked",
        reason: blocked,
        text,
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
        model: model.id,
        stdoutFile,
        stderrFile,
        durationMs,
        fallbacks
      };
    }

    if (markers.length > 0 && !detectMarker(text, markers)) {
      return {
        kind: "attempt",
        reason: `phase ${role} finished without marker ${markers.map(String).join("/")}`,
        text,
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
        model: model.id,
        stdoutFile,
        stderrFile,
        durationMs,
        fallbacks
      };
    }

    return {
      kind: "ok",
      reason: "",
      text,
      metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
      model: model.id,
      stdoutFile,
      stderrFile,
      durationMs,
      fallbacks
    };
  }

  return {
    kind: "exhausted",
    reason: lastReason,
    metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens, cost: totalCost },
    model: candidates[candidates.length - 1]?.id || "",
    fallbacks,
    durationMs: 0
  };
}

export { appendFileSync as appendTrace };
