import { promises as fs } from "node:fs";
import path from "node:path";
import type { Telemetry, TelemetryOptions } from "ai";
import type { AgentConfig } from "../config/schema.js";
import { agentDir } from "../session/store.js";

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
    writeTail = writeTail.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify({ ...event, time: new Date().toISOString() })}\n`, "utf8");
    });
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
    return redactTelemetrySecrets(JSON.stringify(value).slice(0, 8_000));
  } catch {
    return "[unserializable]";
  }
}

function valueFrom(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function redactTelemetrySecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/(api[_-]?key|access[_-]?token|token|secret|password)(\\?"?\s*[:=]\\?"?)([^,\s}]+)/gi, "$1$2[redacted]");
}
