import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { Telemetry, TelemetryOptions } from "ai";
import type { AgentConfig } from "../config/schema.js";
import { agentDir } from "../session/store.js";
import { redactSecrets } from "../utils/secrets.js";

export function createSdkTelemetry(config: AgentConfig, workspaceRoot: string, functionId: string): TelemetryOptions {
  return {
    isEnabled: config.telemetry.enabled,
    recordInputs: config.telemetry.recordInputs,
    recordOutputs: config.telemetry.recordOutputs,
    functionId,
    integrations: createLocalTelemetry(path.join(agentDir(workspaceRoot), "telemetry.jsonl"))
  };
}

export function createLocalTelemetry(filePath: string): Telemetry {
  let writeTail: Promise<void> = Promise.resolve();
  const append = (event: Record<string, unknown>): Promise<void> => {
    // Telemetry is diagnostic only: an unsafe or unavailable sink is disabled
    // without breaking the agent operation that produced the event.
    writeTail = writeTail
      .catch(() => undefined)
      .then(async () => await appendSecureTelemetry(filePath, `${JSON.stringify({ ...event, time: new Date().toISOString() })}\n`))
      .catch(() => undefined);
    return writeTail;
  };

  return {
    onStart: async (event) => await append({
      type: "start",
      operationId: event.operationId,
      provider: event.provider,
      modelId: event.modelId,
      callId: event.callId,
      inputs: event.recordInputs ? safePayload(valueFrom(event, "prompt") ?? valueFrom(event, "messages")) : undefined
    }),
    onStepEnd: async (event) => await append({
      type: "step",
      callId: event.callId,
      stepNumber: event.stepNumber,
      provider: event.model.provider,
      modelId: event.model.modelId,
      usage: sanitizeUsage(event.usage),
      finishReason: event.finishReason,
      outputs: event.recordOutputs ? safePayload(event.text ?? event.content) : undefined
    }),
    onEnd: async (event) => await append({
      type: "end",
      callId: "callId" in event ? event.callId : undefined,
      stepNumber: "stepNumber" in event ? event.stepNumber : undefined,
      usage: "usage" in event ? sanitizeUsage(event.usage) : undefined,
      outputs: event.recordOutputs && "text" in event ? safePayload(event.text) : undefined
    }),
    onError: async (error) => await append({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    })
  };
}

async function appendSecureTelemetry(requestedPath: string, line: string): Promise<void> {
  const requestedDirectory = path.dirname(path.resolve(requestedPath));
  const directoryStat = await fs.lstat(requestedDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Telemetry directory must be a real directory.");
  const directory = await fs.realpath(requestedDirectory);
  const filePath = path.join(directory, path.basename(requestedPath));
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error("Telemetry file must be a single-link regular file.");
  }

  const handle = await fs.open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag(),
    0o600
  );
  try {
    const descriptorStat = await handle.stat();
    const pathStat = await fs.lstat(filePath);
    if (
      !descriptorStat.isFile()
      || descriptorStat.nlink !== 1
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.nlink !== 1
      || pathStat.dev !== descriptorStat.dev
      || pathStat.ino !== descriptorStat.ino
      || await fs.realpath(requestedDirectory) !== directory
    ) {
      throw new Error("Telemetry storage changed during append.");
    }
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

function sanitizeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokenDetails = isRecord(value.inputTokenDetails) ? value.inputTokenDetails : {};
  const outputTokenDetails = isRecord(value.outputTokenDetails) ? value.outputTokenDetails : {};
  return {
    inputTokens: numberValue(value.inputTokens),
    outputTokens: numberValue(value.outputTokens),
    totalTokens: numberValue(value.totalTokens),
    cacheReadTokens: numberValue(inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: numberValue(inputTokenDetails.cacheWriteTokens),
    reasoningTokens: numberValue(outputTokenDetails.reasoningTokens)
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return redactSecrets(JSON.stringify(value).slice(0, 8_000));
  } catch {
    return "[unserializable]";
  }
}

function valueFrom(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
