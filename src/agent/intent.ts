import type { Intent } from "./types.js";

const FILE_PATTERN = /([A-Za-z0-9._/-]+\.(?:json|ts|tsx|js|jsx|md|txt|yml|yaml|css|html))/;

export function detectIntent(input: string): Intent {
  const filePath = extractFilePath(input);
  const command = extractCommand(input);
  const lower = input.toLowerCase();

  if (command || /运行|执行|typecheck|test|build|\bpnpm\b|\bnpm\b/.test(lower)) {
    return { type: "run_command", command: command ?? input.trim() };
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

function cleanCommand(command: string): string {
  return command
    .replace(/\s+(并且|然后|并|and).*$/i, "")
    .trim();
}

function looksLikeCommand(value: string): boolean {
  return /^(pnpm|npm|node|git|tsc|ls|pwd)\b/.test(value.trim());
}
