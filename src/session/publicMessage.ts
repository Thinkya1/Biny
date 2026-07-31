/**
 * 用户消息的展示文本提取。
 *
 * 早期 Durable Task 写进 session 的 user_message 可能包了一层验收脚手架。当前普通 Loop
 * 不再生成这种消息，但回放旧 session 时仍要只展示用户真正输入的部分。
 */
const verifierAttemptMarker = "\n\nThis is a verifier-driven task.";
const continuationPrefix = "Continue the same project-level task autonomously.";
const originalObjectivePrefix = "\n\nOriginal objective: ";
const previousFeedbackPrefix = "\n\nPrevious attempt feedback:";

/** 取出消息中面向用户的那一段；识别不出脚手架时原样返回。 */
export function publicUserMessage(content: string): string {
  // 首次尝试：脚手架追加在用户输入之后，截到标记为止。
  const firstAttemptMarker = content.indexOf(verifierAttemptMarker);
  if (firstAttemptMarker > 0) return content.slice(0, firstAttemptMarker).trimEnd();
  if (!content.startsWith(continuationPrefix)) return content;

  // 续跑尝试：用户输入被夹在「原始目标」和「上次反馈」之间，取中间那段。
  const objectiveStart = content.indexOf(originalObjectivePrefix);
  const feedbackStart = content.indexOf(previousFeedbackPrefix, objectiveStart + originalObjectivePrefix.length);
  if (objectiveStart === -1 || feedbackStart === -1 || feedbackStart <= objectiveStart) return content;
  return content.slice(objectiveStart + originalObjectivePrefix.length, feedbackStart).trim();
}
