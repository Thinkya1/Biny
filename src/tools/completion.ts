/**
 * Completion Gate 的结构化声明工具。
 *
 * 工具本身不执行命令、不决定完成；它只让模型用稳定字段表达“为何被阻塞”或“需要独立重跑
 * 哪些检查”，避免上层解析自然语言答案。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CompletionStateStore } from "../agent/completionState.js";
import type { BlockedState, StructuredVerificationCheck } from "../agent/completionGate.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

const blockedReasonSchema = z.enum([
  "missing_user_input",
  "waiting_for_approval",
  "permission_denied",
  "missing_dependency",
  "environment_unavailable",
  "external_service_failure",
  "unsafe_action_required"
]);

const reportBlockedSchema = z.object({
  reason: blockedReasonSchema,
  summary: z.string().min(1).max(2_000),
  requiredAction: z.string().min(1).max(2_000).optional(),
  affectedTodoIds: z.array(z.string().min(1).max(200)).max(50).optional()
}) satisfies z.ZodType<BlockedState>;

const verificationCheckSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.literal("command"),
  description: z.string().min(1).max(500),
  command: z.string().min(1).max(4_000),
  cwd: z.string().min(1).max(1_000).optional(),
  processId: z.undefined().optional()
}) satisfies z.ZodType<StructuredVerificationCheck>;

const requestVerificationSchema = z.object({
  checks: z.array(verificationCheckSchema).min(1).max(16)
});

export function createCompletionStateTools(store: CompletionStateStore): Array<Tool<unknown, unknown>> {
  return [createReportBlockedTool(store), createRequestVerificationTool(store)] as Array<Tool<unknown, unknown>>;
}

function createReportBlockedTool(store: CompletionStateStore): Tool<BlockedState, BlockedState> {
  return {
    name: "report_blocked",
    description: "Report a structured blocker only when the current user task cannot continue without user input, approval, a missing dependency, an unavailable environment or service, or an unsafe action. This does not mark the task completed.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: blockedReasonSchema.options },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        requiredAction: { type: "string", minLength: 1, maxLength: 2_000 },
        affectedTodoIds: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 200 } }
      },
      required: ["reason", "summary"],
      additionalProperties: false
    },
    schema: reportBlockedSchema,
    capability: "completion.blocked",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        approvalRule: "report_blocked",
        display: { kind: "generic", summary: `Report blocker: ${args.summary}` },
        async execute() {
          return store.reportBlocked(args);
        }
      };
    }
  };
}

function createRequestVerificationTool(
  store: CompletionStateStore
): Tool<z.infer<typeof requestVerificationSchema>, { checks: StructuredVerificationCheck[] }> {
  return {
    name: "request_verification",
    description: "Register deterministic commands that Biny must rerun independently before completing this turn. Use when the user explicitly requests a check or when a required check cannot be derived from changed project files.",
    parameters: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128 },
              kind: { type: "string", enum: ["command"] },
              description: { type: "string", minLength: 1, maxLength: 500 },
              command: { type: "string", minLength: 1, maxLength: 4_000 },
              cwd: { type: "string", minLength: 1, maxLength: 1_000 }
            },
            required: ["id", "kind", "description", "command"],
            additionalProperties: false
          }
        }
      },
      required: ["checks"],
      additionalProperties: false
    },
    schema: requestVerificationSchema,
    capability: "completion.verify",
    // 这里只登记验收要求，不执行其中的命令；真正执行时仍会经过独立权限门。
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        approvalRule: `request_verification:${createHash("sha256")
          .update(JSON.stringify(args.checks))
          .digest("hex")}`,
        display: { kind: "generic", summary: `Register ${String(args.checks.length)} completion checks` },
        async execute() {
          return { checks: store.replaceChecks(args.checks) };
        }
      };
    }
  };
}
