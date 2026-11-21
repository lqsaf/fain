import { createHash, randomBytes } from "node:crypto";

export function createLogRecord({ at, runId, taskId = "", correlationId = "", event, data = {} }) {
  const task = data.task || taskId;
  const id = correlationId || data.correlationId || `${runId || "fa"}:run`;
  const traceId = createHash("sha256").update(id).digest("hex").slice(0, 32);
  const spanId = randomBytes(8).toString("hex");
  return {
    at,
    runId: runId || "",
    correlationId: id,
    traceId,
    spanId,
    event,
    ...(task ? { task } : {}),
    ...data,
    correlationId: id,
    traceId,
    spanId
  };
}
