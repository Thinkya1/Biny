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

  if (command || /运行|执行|typecheck|\bpnpm\b|\bnpm\b/.test(lower)) {
    return { type: "run_command", command: command ?? input.trim() };
  }

  if (writeTarget) {
    return { type: "write_file", filePath: writeTarget.path, content: writeTarget.content };
  }

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
  return input.match(FILE_PATTERN)?.[1];
}

export function extractCommand(input: string): string | undefined {
  const quoted = input.match(/["“']([^"”']+)["”']/)?.[1];
  if (quoted && looksLikeCommand(quoted)) return quoted;

  const pnpm = input.match(/\bpnpm\s+[A-Za-z0-9:_-]+(?:\s+[^\n，。]*)?/);
  if (pnpm) return cleanCommand(pnpm[0]);

  const npm = input.match(/\bnpm\s+(?:run\s+)?[A-Za-z0-9:_-]+(?:\s+[^\n，。]*)?/);
  if (npm) return cleanCommand(npm[0]);

  if (/\btsc\b/.test(input)) return "pnpm typecheck";
  return undefined;
}

export function extractWriteFile(input: string): { path: string; content: string } | undefined {
  const english = input.match(/(?:write|create|new)\s+(?:a\s+)?(?:file\s+)?([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\s*(?:(?:with|content:|content is)\s*([\s\S]+))?$/i);
  if (english?.[1]) return { path: english[1], content: (english[2] ?? "").trim() };

  const chinese = input.match(/(?:写入|创建|新建)\s*(?:一个|一份)?\s*(?:文件)?\s*([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\s*(?:(?:文件)?\s*(?:内容为|内容是|内容:|写入|：|:)\s*([\s\S]+))?$/);
  if (chinese?.[1]) return { path: chinese[1], content: (chinese[2] ?? "").trim() };

  const path = extractFilePath(input);
  if (path && /创建|新建|写入|create|write|new file/i.test(input)) {
    return { path, content: extractLooseWriteContent(input, path) };
  }

  return undefined;
}

function extractLooseWriteContent(input: string, path: string): string {
  const afterPath = input.slice(input.indexOf(path) + path.length);
  const content = afterPath.match(/(?:内容为|内容是|内容:|写入|with|content:|content is|：|:)\s*([\s\S]+)$/i)?.[1];
  return content?.trim() ?? "";
}

export function extractSearchQuery(input: string): string | undefined {
  const quoted = input.match(/(?:搜索|查找|search|find)\s+["“']([^"”']+)["”']/i)?.[1];
  if (quoted) return quoted.trim();

  const chinese = input.match(/(?:搜索|查找)\s+([^\n，。]+)/)?.[1];
  if (chinese) return chinese.trim();

  const english = input.match(/(?:search|find)\s+(.+)$/i)?.[1];
  if (english) return english.trim();

  return undefined;
}

function cleanCommand(command: string): string {
  return command
    .replace(/\s+(并且|然后|并|and).*$/i, "")
    .trim();
}

function looksLikeCommand(value: string): boolean {
  return /^(pnpm|npm|node|git|tsc|ls|pwd)\b/.test(value.trim());
}
