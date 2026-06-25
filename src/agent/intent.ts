/**
 * 轻量意图识别模块。
 *
 * 在模型工具调用接入前，agent 通过这些保守规则识别读文件、写文件、编辑、搜索和执行命令。
 * 规则宁可漏判也不应误判为有副作用操作，因此命令、写入和编辑的匹配都保持明确边界。
 */
import type { Intent } from "./types.js";

const FILE_PATTERN = /([A-Za-z0-9._/-]+\.(?:json|ts|tsx|js|jsx|md|txt|yml|yaml|css|html))/;

export function detectIntent(input: string): Intent {
  // Mock 阶段没有模型决策工具调用，所以用规则识别常见意图。
  // 规则要保持保守：识别不到时走 qa，不要误执行有副作用工具。
  const filePath = extractFilePath(input);
  const command = extractCommand(input);
  const writeTarget = extractWriteFile(input);
  const searchQuery = extractSearchQuery(input);
  const lower = input.toLowerCase();

  if (/\bgit\s+diff\b/.test(lower) || /查看\s*git\s*diff/i.test(input)) {
    return { type: "git_diff" };
  }

  // 命令识别优先级最高，因为命令文本里也可能包含文件名或搜索词。
  if (command || /运行|执行|typecheck|\bpnpm\b|\bnpm\b/.test(lower)) {
    return { type: "run_command", command: command ?? input.trim() };
  }

  // 写文件是有副作用操作，只有匹配到明确目标文件时才返回 write_file。
  if (writeTarget) {
    return { type: "write_file", filePath: writeTarget.path, content: writeTarget.content };
  }

  // 搜索意图早于编辑意图，避免“查找 update”被误判成 edit_file。
  if (searchQuery) {
    return { type: "search_files", query: searchQuery };
  }

  if (/修改|改成|添加|删除|edit|change|update/i.test(input)) {
    return { type: "edit_file", filePath };
  }

  if (filePath) {
    return { type: "read_file", filePath };
  }

  return { type: "qa" };
}

export function extractFilePath(input: string): string | undefined {
  // 只支持常见源码/文档后缀，降低普通文本被误识别为路径的概率。
  return input.match(FILE_PATTERN)?.[1];
}

export function extractCommand(input: string): string | undefined {
  // 引号中的命令优先，适合用户说“执行 "pnpm test"”。
  const quoted = input.match(/["“']([^"”']+)["”']/)?.[1];
  if (quoted && looksLikeCommand(quoted)) return quoted;

  // 常见包管理器命令允许带简单参数，但在中文逗号/句号处截断。
  const pnpm = input.match(/\bpnpm\s+[A-Za-z0-9:_-]+(?:\s+[^\n，。]*)?/);
  if (pnpm) return cleanCommand(pnpm[0]);

  const npm = input.match(/\bnpm\s+(?:run\s+)?[A-Za-z0-9:_-]+(?:\s+[^\n，。]*)?/);
  if (npm) return cleanCommand(npm[0]);

  if (/\btsc\b/.test(input)) return "pnpm typecheck";
  return undefined;
}

export function extractWriteFile(input: string): { path: string; content: string } | undefined {
  // 英文和中文都先匹配“创建/写入 文件 内容”这种强结构表达。
  const english = input.match(/(?:write|create|new)\s+(?:a\s+)?(?:file\s+)?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\s*(?:(?:with|content:|content is)\s*([\s\S]+))?$/i);
  if (english?.[1]) return { path: english[1], content: (english[2] ?? "").trim() };

  const chinese = input.match(/(?:写入|创建|新建)\s*(?:一个|一份)?\s*(?:文件)?\s*([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\s*(?:(?:文件)?\s*(?:内容为|内容是|内容:|写入|：|:)\s*([\s\S]+))?$/);
  if (chinese?.[1]) return { path: chinese[1], content: (chinese[2] ?? "").trim() };

  const path = extractFilePath(input);
  if (path && /创建|新建|写入|create|write|new file/i.test(input)) {
    // 如果结构化表达没匹配上，再从路径后面宽松提取内容。
    return { path, content: extractLooseWriteContent(input, path) };
  }

  return undefined;
}

function extractLooseWriteContent(input: string, path: string): string {
  // 宽松提取只看目标路径之后的内容，避免把前半句说明当成文件正文。
  const afterPath = input.slice(input.indexOf(path) + path.length);
  const content = afterPath.match(/(?:内容为|内容是|内容:|写入|with|content:|content is|：|:)\s*([\s\S]+)$/i)?.[1];
  return content?.trim() ?? "";
}

export function extractSearchQuery(input: string): string | undefined {
  // 引号包裹的搜索词最可靠，应优先保留原样。
  const quoted = input.match(/(?:搜索|查找|search|find)\s+["“']([^"”']+)["”']/i)?.[1];
  if (quoted) return quoted.trim();

  const chinese = input.match(/(?:搜索|查找)\s+([^\n，。]+)/)?.[1];
  if (chinese) return chinese.trim();

  const english = input.match(/(?:search|find)\s+(.+)$/i)?.[1];
  if (english) return english.trim();

  return undefined;
}

function cleanCommand(command: string): string {
  // 从自然语言句子里截出第一条命令，避免“然后...”进入 shell。
  return command
    .replace(/\s+(并且|然后|并|and).*$/i, "")
    .trim();
}

function looksLikeCommand(value: string): boolean {
  // 只允许常见命令作为自动识别目标，降低误执行风险。
  return /^(pnpm|npm|node|git|tsc|ls|pwd)\b/.test(value.trim());
}
