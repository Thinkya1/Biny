/**
 * 思考步骤的展示文本。
 *
 * 部分模型只上报「在思考」而不返回内容，展开后不能是空白，这里统一兜底成一句提示。
 */
import type { TimelineReasoningStep } from "./sessionTimeline.js";

export function reasoningDetailText(step: Pick<TimelineReasoningStep, "content">): string {
  return step.content.trim() || "该模型未返回可展示的思考内容";
}
