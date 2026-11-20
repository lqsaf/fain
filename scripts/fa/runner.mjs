// Исполнитель одной фазы: запускает `opencode run` на модели, извлечённой
// router'ом, и переключается на следующую модель только при инфраструктурном
// отказе. Ошибки кода не тратят модели: они возвращаются оркестратору.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCODE_BIN, ROOT } from "./config.mjs";
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
  env = process.env
}) {
  if (timeoutMs <= 0) {
    return { kind: "budget", reason: "run time budget exhausted before phase start", metrics: { tokenTotal: 0 }, model: "", fallbacks: 0 };
  }
  const contextTokens = estimateTokens(prompt.length);
  const estimate = estimatePhaseTokens(role, { contextTokens });
  const candidates = session.candidates(role, { avoidProvider, exclude: excludeModels });
  let fallbacks = 0;
  let lastReason = "no model available";
  let totalTokens = 0;
  let totalBudgetTokens = 0;

  if (candidates.length === 0) {
    return { kind: "exhausted", reason: `no available model for role ${role}`, metrics: { tokenTotal: 0 }, model: "", fallbacks };
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const reserved = await session.reserve(role, {
      estimateTokens: estimate,
      avoidProvider,
      exclude: [...excludeModels, ...candidates.slice(0, index).map((item) => item.id)]
    });
    if (!reserved.ok) {
      lastReason = reserved.reason;
      if (reserved.budgetExhausted) {
        return {
          kind: "budget",
          reason: reserved.reason,
          metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
          model: "",
          fallbacks
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
    const selectedAgent = model.dailyLimit ? "fa-scarce" : agent;
    log("model.start", {
      task: taskId,
      phase: role,
      model: model.id,
      agent: selectedAgent,
      message: `${model.id} (${index + 1}/${candidates.length})${model.dailyLimit ? " single-turn" : ""}`
    });

    const started = Date.now();
    const providerEnv = session.providerEnv(model, env);
    const result = await spawnOpencode({
      args: ["run", "--agent", selectedAgent, "--model", model.id, "--format", "json", "--auto", "--title", title, prompt],
      timeoutMs,
      env: providerEnv
    });
    writeFileSync(stdoutFile, result.stdout || "", "utf8");
    writeFileSync(stderrFile, result.stderr || "", "utf8");

    const metrics = analyzeFile(stdoutFile);
    totalTokens += metrics.tokenTotal;
    totalBudgetTokens += metrics.tokenTotal > 0 ? metrics.tokenTotal : estimate;
    const durationMs = Date.now() - started;

    if (result.spawnError || result.timedOut) {
      session.failover(reserved.reservation, "unavailable", result.spawnError?.message || "timeout");
      const reason = result.spawnError?.message || `timeout after ${Math.round(timeoutMs / 1000)}s`;
      log("model.infra", { task: taskId, phase: role, model: model.id, message: reason });
      return {
        kind: "infra",
        reason,
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
        model: model.id,
        stdoutFile,
        stderrFile,
        durationMs,
        fallbacks
      };
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
      return {
        kind: category === "other" ? "attempt" : "exhausted",
        reason: `opencode exit ${result.code}: ${detail}`,
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
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
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
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
        metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
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
      metrics: { ...metrics, tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
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
    metrics: { tokenTotal: totalTokens, budgetTokens: totalBudgetTokens },
    model: candidates[candidates.length - 1]?.id || "",
    fallbacks,
    durationMs: 0
  };
}

export { appendFileSync as appendTrace };
