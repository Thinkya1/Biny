import path from "node:path";
import { isIgnoredPath } from "./ignore.js";

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string, ignore: string[]): string {
  const absolute = path.resolve(workspaceRoot, requestedPath);
  const relative = path.relative(workspaceRoot, absolute);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  if (isIgnoredPath(relative, ignore)) {
    throw new Error(`Path is ignored by workspace policy: ${requestedPath}`);
  }

  return absolute;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath) || ".";
}
