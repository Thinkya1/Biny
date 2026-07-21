import type { AgentHostEvent } from "../../runtime/agentEvents.js";
import type { RuntimeEvent } from "../../runtime/events.js";

export function agentEventToRuntimeEvents(event: AgentHostEvent): RuntimeEvent[] {
  switch (event.type) {
    case "run.started":
      return [{ type: "runtime.status", status: "thinking" }];
    case "message.user":
      return [{ type: "user.message", content: event.content }];
    case "assistant.delta":
      return [{ type: "assistant.delta", content: event.content }];
    case "assistant.completed":
      return event.content ? [{ type: "assistant.completed", content: event.content }] : [];
    case "reasoning.started":
      return [{ type: "runtime.status", status: "thinking" }];
    case "reasoning.delta":
      return [];
    case "tool.started":
      return [{
        type: "tool.call.started",
        toolCallId: event.toolCallId,
        tool: event.tool,
        args: event.args,
        description: event.description,
        display: event.display
      }];
    case "tool.progress":
      return [{ type: "tool.call.progress", toolCallId: event.toolCallId, tool: event.tool, update: event.update }];
    case "tool.completed":
      return [{ type: "tool.call.completed", toolCallId: event.toolCallId, tool: event.tool, result: event.result }];
    case "tool.failed":
      return [{ type: "tool.call.failed", toolCallId: event.toolCallId, tool: event.tool, error: event.error }];
    case "permission.requested":
      return [{
        type: "permission.requested",
        tool: event.request.tool,
        title: event.request.title,
        details: event.request.details,
        requireFullYes: event.request.requireFullYes,
        diff: event.request.diff,
        preview: event.request.preview,
        actionType: event.request.actionType,
        riskLevel: event.request.riskLevel,
        targetPath: event.request.targetPath,
        command: event.request.command,
        reason: event.request.reason,
        changeSummary: event.request.changeSummary
      }];
    case "permission.resolved":
      return [event.approved
        ? { type: "permission.approved", tool: event.tool, scope: event.scope ?? "once" }
        : { type: "permission.rejected", tool: event.tool, reason: event.message }];
    case "run.completed":
      return [
        { type: "runtime.status", status: "completed" },
        { type: "session.completed", sessionId: event.sessionId }
      ];
    case "run.incomplete":
      return [
        { type: "runtime.status", status: "incomplete" },
        { type: "session.incomplete", sessionId: event.sessionId, message: event.reason }
      ];
    case "run.aborted":
      return [
        { type: "runtime.status", status: "aborted" },
        { type: "session.aborted", sessionId: event.sessionId, message: event.reason }
      ];
    case "run.failed":
      return [{ type: "session.error", sessionId: event.sessionId, message: event.error }];
    case "reasoning.status":
    case "reasoning.completed":
    case "command.started":
    case "command.output":
    case "command.completed":
    case "command.failed":
    case "file.read":
    case "file.changed":
    case "diff.created":
    case "context.updated":
    case "compact.started":
    case "compact.completed":
      return [];
  }
}
