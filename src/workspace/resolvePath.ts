/**
 * 工作区路径解析模块。
 *
 * 文件工具统一通过这里把用户传入路径转换成工作区内绝对路径。`../`、绝对路径逃逸以及命中
 * ignore 规则的路径都会被拒绝，避免工具访问项目边界之外的内容。
 */
import path from "node:path";
import { isIgnoredPath } from "./ignore.js";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string, ignore: string[]): string {
  const absolute = path.resolve(workspaceRoot, requestedPath);
  const relative = path.relative(workspaceRoot, absolute);

  // 所有文件工具都必须先过这个检查，防止通过 ../ 或绝对路径逃出工作区。
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  // ignore 既保护 node_modules/.git 这类大目录，也避免本地私有说明文件进入工具结果。
  if (isIgnoredPath(relative, ignore)) {
    throw new Error(`Path is ignored by workspace policy: ${requestedPath}`);
  }

  return absolute;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath) || ".";
}
