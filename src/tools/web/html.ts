/**
 * HTML 转纯文本模块。
 *
 * 抓回来的网页要变成模型能读的文本：脚本样式整块丢掉，块级标签换成换行，其余标签剥掉，
 * 实体解码。目标是可读，不是还原排版。
 */

const strippedBlocks = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const lineBreakTags = /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi;
const listItemTags = /<li\b[^>]*>/gi;

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(strippedBlocks, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(lineBreakTags, "\n")
      .replace(listItemTags, "\n- ")
      .replace(/<[^>]*>/g, "")
  )
    // 逐行收紧空白，再把三行以上的空行压成一个段落间隔。
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = match?.[1] === undefined ? "" : decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
  return title || undefined;
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const numeric = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}
