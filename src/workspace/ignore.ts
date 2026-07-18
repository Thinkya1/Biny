/**
 * 工作区忽略规则模块。
 *
 * ignore 规则按路径片段匹配，而不是只匹配完整路径。这样 `node_modules/foo`、`.git/config`
 * 和本地私有文档子路径都会被统一排除在扫描和文件工具之外。
 */
import { isProtectedCredentialPath } from "../utils/secrets.js";

export function isIgnoredPath(relativePath: string, ignore: string[]): boolean {
  // ignore 按路径片段匹配，确保 node_modules/foo 和 .git/config 这类子路径都会被排除。
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean);
  return isProtectedCredentialPath(relativePath) || normalized.some((segment) => ignore.includes(segment));
}
