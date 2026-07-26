/**
 * Transcript 条目组件。
 *
 * 每种条目对应一个 pi-tui 组件：用户消息和工具调用是带背景色的整宽卡片，
 * assistant 正文和 thinking 走 Markdown 渲染，通知和错误是单行文本。
 * 组件只负责展示，内容由 `TranscriptView` 从 reducer 状态同步进来。
 */
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { markdownTheme, theme } from "../theme/index.js";
import { formatToolDuration, thinkingHeaderLabel } from "../transcriptText.js";
import type {
  AssistantTranscriptItem,
  NotificationTranscriptItem,
  ReasoningTranscriptItem,
  ToolTranscriptItem,
  ToolTranscriptStatus,
  TranscriptItem
} from "../types.js";

/** 条目组件的公共契约：能按条目更新自己。 */
export interface TranscriptItemComponent extends Container {
  readonly itemId: string;
  update(item: TranscriptItem): void;
}

/** 用户消息：整宽背景卡片，上下各一行同色留白，内容缩进一格。 */
export class UserMessageComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly body: Markdown;

  constructor(item: Extract<TranscriptItem, { kind: "user" }>) {
    super();
    this.itemId = item.id;
    this.body = new Markdown(item.content, 0, 0, markdownTheme(), {
      color: (text) => theme.fg("userMessageText", text)
    }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true });
    const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
    box.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(box);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "user") return;
    this.body.setText(item.content);
  }
}

/** Assistant 正文：不加背景，缩进一格，走完整 Markdown。 */
export class AssistantMessageComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly body: Markdown;

  constructor(item: AssistantTranscriptItem) {
    super();
    this.itemId = item.id;
    this.body = new Markdown(item.content, 1, 0, markdownTheme());
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "assistant") return;
    this.body.setText(item.content);
  }
}

/** Thinking：斜体 + thinkingText，折叠时只留一行标题。 */
export class ThinkingComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly header: Text;
  private readonly body: Markdown;
  private collapsed: boolean;
  private item: ReasoningTranscriptItem;

  constructor(item: ReasoningTranscriptItem, collapsed: boolean) {
    super();
    this.itemId = item.id;
    this.collapsed = collapsed;
    this.item = item;
    this.header = new Text(thinkingHeader(item, collapsed), 1, 0);
    this.body = new Markdown(item.content.trim(), 1, 0, markdownTheme(), {
      color: (text) => theme.fg("thinkingText", text),
      italic: true
    });
    this.addChild(new Spacer(1));
    this.rebuild();
  }

  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.rebuild();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "reasoning") return;
    this.item = item;
    this.header.setText(thinkingHeader(item, this.collapsed));
    this.body.setText(item.content.trim());
  }

  private rebuild(): void {
    this.header.setText(thinkingHeader(this.item, this.collapsed));
    this.children = [new Spacer(1), this.header];
    if (!this.collapsed) this.children.push(this.body);
  }
}

function thinkingHeader(item: ReasoningTranscriptItem, collapsed: boolean): string {
  const running = item.startedAtMs !== undefined && item.durationMs === undefined;
  const marker = collapsed ? "▸ " : "▾ ";
  return theme.fg("thinkingText", `${marker}${theme.italic(thinkingHeaderLabel(item, running))}`);
}

/** 工具调用：整宽卡片，背景色表达状态；标题是动词加粗 + 目标强调色 + 右对齐耗时。 */
export class ToolExecutionComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly box: Box;
  private readonly title: Text;
  private readonly output: Text;
  private item: ToolTranscriptItem;
  private expanded = false;

  constructor(item: ToolTranscriptItem) {
    super();
    this.itemId = item.id;
    this.item = item;
    this.title = new ToolTitleText(item);
    this.output = new Text("", 1, 0);
    this.box = new Box(1, 1, (text) => theme.bg(toolBackgroundToken(item.status), text));
    this.box.addChild(this.title);
    this.box.addChild(this.output);
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.refresh();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.refresh();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "tool") return;
    this.item = item;
    this.refresh();
  }

  private refresh(): void {
    (this.title as ToolTitleText).setItem(this.item);
    this.box.setBgFn((text) => theme.bg(toolBackgroundToken(this.item.status), text));
    const source = this.expanded
      ? this.item.details ?? this.item.output ?? emptyToolOutput(this.item)
      : this.item.output ?? this.item.progress ?? emptyToolOutput(this.item);
    this.output.setText(toolOutputText(source, this.item.status, this.expanded));
  }
}

/** 标题行需要按渲染宽度右对齐耗时，所以自己实现 render。 */
class ToolTitleText extends Text {
  private item: ToolTranscriptItem;

  constructor(item: ToolTranscriptItem) {
    super("", 0, 0);
    this.item = item;
  }

  setItem(item: ToolTranscriptItem): void {
    this.item = item;
    this.invalidate();
  }

  override render(width: number): string[] {
    const marker = toolStatusMarker(this.item.status);
    const { verb, rest } = splitToolTitle(this.item.title);
    const running = this.item.status === "running" && this.item.startedAtMs !== undefined
      ? Math.max(0, Date.now() - this.item.startedAtMs)
      : undefined;
    const duration = formatToolDuration(this.item.durationMs ?? running);

    const left = `${marker}${verb}${rest}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(duration));
    const styledLeft = theme.fg(toolStatusToken(this.item.status), marker)
      + theme.fg("toolTitle", theme.bold(verb))
      + theme.fg("accent", rest);

    if (!duration || visibleWidth(left) + 1 + visibleWidth(duration) > width) {
      return [truncateToWidth(styledLeft, width, "…")];
    }
    return [`${styledLeft}${" ".repeat(gap)}${theme.fg("dim", duration)}`];
  }
}

/** 标题首词是动作，加粗展示；其余部分是操作目标。 */
export function splitToolTitle(title: string): { verb: string; rest: string } {
  const boundary = title.indexOf(" ");
  if (boundary <= 0) return { verb: title, rest: "" };
  return { verb: title.slice(0, boundary), rest: title.slice(boundary) };
}

/** 未展开时只显示末尾若干行，运行中的工具优先显示最新输出。 */
const defaultToolOutputLines = 4;

function toolOutputText(source: string, status: ToolTranscriptStatus, expanded: boolean): string {
  const normalized = source.replaceAll("\t", "    ").trimEnd();
  if (!normalized) return "";
  const colorize = (text: string): string => (status === "failed" || status === "denied"
    ? theme.fg("error", text)
    : theme.fg("toolOutput", text));
  if (expanded) return colorize(normalized);

  const lines = normalized.split("\n");
  if (lines.length <= defaultToolOutputLines) return colorize(normalized);
  const running = status === "running" || status === "pending";
  const visible = running ? lines.slice(-defaultToolOutputLines) : lines.slice(0, defaultToolOutputLines);
  const hidden = lines.length - visible.length;
  const notice = theme.fg("dim", `… ${String(hidden)} ${running ? "earlier" : "more"} line${hidden === 1 ? "" : "s"}`);
  return running
    ? `${notice}\n${colorize(visible.join("\n"))}`
    : `${colorize(visible.join("\n"))}\n${notice}`;
}

function emptyToolOutput(item: ToolTranscriptItem): string {
  if (item.status === "running" || item.status === "pending") return "Working…";
  if (item.status === "success") return "Completed";
  if (item.status === "denied") return "Denied";
  if (item.status === "skipped") return "Skipped";
  return "Failed";
}

export function toolStatusMarker(status: ToolTranscriptStatus): string {
  if (status === "success") return "✓ ";
  if (status === "failed" || status === "denied") return "✗ ";
  if (status === "running") return "● ";
  if (status === "pending") return "○ ";
  if (status === "skipped") return "– ";
  return "• ";
}

function toolStatusToken(status: ToolTranscriptStatus): "success" | "error" | "accent" | "warning" | "muted" {
  if (status === "success") return "success";
  if (status === "failed" || status === "denied") return "error";
  if (status === "running") return "accent";
  if (status === "pending") return "warning";
  return "muted";
}

function toolBackgroundToken(status: ToolTranscriptStatus): "toolSuccessBg" | "toolErrorBg" | "toolPendingBg" {
  if (status === "success") return "toolSuccessBg";
  if (status === "failed" || status === "denied") return "toolErrorBg";
  return "toolPendingBg";
}

/** 系统通知和错误：单行文本，按语气着色。 */
export class NoticeComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly text: Text;
  private readonly kind: "notification" | "error";

  constructor(item: NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>) {
    super();
    this.itemId = item.id;
    this.kind = item.kind;
    this.text = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.text);
    this.update(item);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== this.kind) return;
    this.text.setText(noticeText(item as NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>));
  }
}

function noticeText(item: NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>): string {
  if (item.kind === "error") return theme.fg("error", `Error ${item.content}`);
  if (item.tone === "success") return theme.fg("success", `• ${item.content}`);
  if (item.tone === "warning") return theme.fg("warning", `• ${item.content}`);
  return theme.fg("muted", `• ${item.content}`);
}
