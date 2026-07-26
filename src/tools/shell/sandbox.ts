/**
 * macOS 命令沙箱模块。
 *
 * 在此之前，命令执行的全部防线是 `policy.ts` 里那套对命令字符串的正则判定。正则判定天然
 * 可绕（`eval`、`$(...)`、base64、换个等价命令），而它一旦判错就没有第二道 —— 用户点了
 * 同意，命令就以完整用户权限运行。
 *
 * 这里加的是那道独立于判定的边界：内核级地限制写入范围，可选禁网。它不依赖"命令看起来
 * 像什么"，所以判定错了也还有兜底。
 *
 * 范围与限制（不夸大）：
 * - 只在 macOS 生效。其他平台返回原命令，`describeSandbox()` 会如实说明。
 * - `sandbox-exec` 被 Apple 标记为 deprecated，但至今仍是唯一无需额外安装的用户态方案。
 * - 读取默认放行。挡住读取会让绝大多数构建和测试命令直接失败，收益不抵代价；这里防的是
 *   工作区之外的**改动**和意外出网。
 */
import { realpathSync } from "node:fs";
import path from "node:path";

export type SandboxMode = "off" | "workspace-write";

export interface SandboxOptions {
  mode: SandboxMode;
  allowNetwork: boolean;
}

export interface SandboxedCommand {
  command: string;
  applied: boolean;
  /** 未生效的原因，用于如实告知而不是假装有沙箱。 */
  reason?: string;
}

/** 构建产物、包管理器缓存等必须可写，否则常规命令会大面积失败。 */
function writableRoots(workspaceRoot: string, homeDirectory: string, temporaryDirectory: string): string[] {
  return [
    workspaceRoot,
    temporaryDirectory,
    "/private/tmp",
    "/private/var/tmp",
    "/dev",
    path.join(homeDirectory, ".npm"),
    path.join(homeDirectory, ".cache"),
    path.join(homeDirectory, "Library", "Caches"),
    path.join(homeDirectory, ".pnpm-store")
  ];
}

export function buildSeatbeltProfile(workspaceRoot: string, options: SandboxOptions, environment: {
  home: string;
  temporaryDirectory: string;
}): string {
  // seatbelt 匹配的是解析后的真实路径。macOS 上 /tmp、/var 都是符号链接，直接用原路径写
  // 规则会让工作区自己也被挡在外面 —— 两条都写，才能覆盖调用方传进来的那种写法。
  const roots = writableRoots(path.resolve(workspaceRoot), environment.home, environment.temporaryDirectory);
  const writable = [...new Set(roots.flatMap((entry) => [entry, realPath(entry)]))]
    .map((entry) => `  (subpath ${quoteScheme(entry)})`)
    .join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    writable,
    ")",
    // 写入 /dev/null、tty 是命令的日常行为，单独放行避免误伤。
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    ...(options.allowNetwork ? [] : ["(deny network*)"]),
    ""
  ].join("\n");
}

/**
 * 把命令包进沙箱。返回值里的 `applied` 表示这次是否真的有边界 —— 调用方据此如实告知用户，
 * 而不是让"沙箱模式"这个名字自己去暗示一个不存在的保护。
 */
export function sandboxCommand(
  command: string,
  workspaceRoot: string,
  options: SandboxOptions,
  environment: { platform: NodeJS.Platform; home: string; temporaryDirectory: string }
): SandboxedCommand {
  if (options.mode === "off") return { command, applied: false, reason: "sandbox is disabled in configuration" };
  if (environment.platform !== "darwin") {
    return { command, applied: false, reason: `command sandboxing is only implemented for macOS; this host is ${environment.platform}` };
  }
  const profile = buildSeatbeltProfile(workspaceRoot, options, environment);
  return {
    command: `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/sh -c ${shellQuote(command)}`,
    applied: true
  };
}

export function describeSandbox(options: SandboxOptions, platform: NodeJS.Platform): string {
  if (options.mode === "off") return "off";
  if (platform !== "darwin") return `requested but unavailable on ${platform}`;
  return options.allowNetwork ? "workspace-write" : "workspace-write, no network";
}

/** seatbelt 的路径字面量走 scheme 字符串，内部的引号和反斜杠必须转义。 */
function quoteScheme(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function realPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    // 目录还不存在（比如缓存目录首次使用）时按原样写规则即可。
    return value;
  }
}
