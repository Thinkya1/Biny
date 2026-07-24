import type { TimelineReasoningStep } from "./sessionTimeline.js";

export function reasoningDetailText(step: Pick<TimelineReasoningStep, "content">): string {
  return step.content.trim() || "该模型未返回可展示的思考内容";
}
