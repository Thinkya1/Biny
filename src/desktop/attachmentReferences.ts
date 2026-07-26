/**
 * 附件引用块。
 *
 * 带附件发送时，附件路径会以固定格式追加到 prompt 末尾——模型要靠这段文本才知道去哪读文件。
 * 但这段是写给模型的，界面上应该还原成附件卡片而不是原样显示，所以生成和解析放在同一个文件里，
 * 改格式时两边不会走散；历史会话里存的也是这个格式，解析必须一直兼容。
 */
import type { DesktopAttachment } from "./protocol.js";

export interface AttachmentReference {
  path: string;
  /** 去掉保存时加的时间戳前缀后的原始文件名，只用于展示。 */
  name: string;
  mimeType?: string;
  size?: number;
}

const referenceHeading = "Attached files (read them with read_file using these @attachments/ paths):";
const referenceLine = /^- (\S+) \(([^()]*), (\d+) bytes\)$/;
/** `saveAttachment` 存盘时加的 `<时间戳>-<随机串>-` 前缀。 */
const storedNamePrefix = /^\d+-[\da-f]{6}-/;

export function withAttachmentReferences(input: string, attachments: DesktopAttachment[]): string {
  if (!attachments.length) return input;
  return [
    input,
    "",
    referenceHeading,
    ...attachments.map((attachment) => `- ${attachment.path} (${attachment.mimeType || "unknown type"}, ${String(attachment.size)} bytes)`)
  ].join("\n");
}

/** 把附件清单从消息里剥出来；格式对不上时原样返回，宁可显示得丑也不要吞掉用户内容。 */
export function splitAttachmentReferences(content: string): { text: string; attachments: AttachmentReference[] } {
  const headingStart = content.lastIndexOf(`\n${referenceHeading}\n`);
  if (headingStart === -1) return { text: content, attachments: [] };

  const attachments: AttachmentReference[] = [];
  for (const line of content.slice(headingStart + referenceHeading.length + 2).split("\n")) {
    const match = referenceLine.exec(line);
    if (!match) return { text: content, attachments: [] };
    const path = match[1] ?? "";
    const mimeType = match[2] ?? "";
    attachments.push({
      path,
      name: path.split("/").at(-1)?.replace(storedNamePrefix, "") ?? path,
      mimeType: mimeType === "unknown type" ? undefined : mimeType,
      size: Number(match[3])
    });
  }
  return { text: content.slice(0, headingStart).trimEnd(), attachments };
}
