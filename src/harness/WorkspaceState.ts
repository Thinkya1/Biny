/**
 * 工作区状态指纹。
 *
 * 用来判断一次任务尝试到底改没改文件：把工作区所有受管文件的「相对路径 + 大小 + 内容
 * 哈希」拼起来再哈希一次。目录项按名字排序，保证同样的文件树一定得到同样的指纹。
 */
import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "../workspace/ignore.js";

// 运行时目录和构建产物会频繁变化，纳入指纹会让「有没有改动」永远为真。
const ignoredDirectoryNames = new Set([".agent", ".git", "node_modules", "dist", "build", "out", "target", "coverage"]);
const maxEntries = 20_000;
const maxContentBytes = 64 * 1024 * 1024;

/** 计算工作区指纹，排除运行时和构建产物；条目数超限直接报错而不是悄悄截断。 */
export async function workspaceStateDigest(workspaceRoot: string, ignore: string[] = []): Promise<string> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const entries: string[] = [];
  let visited = 0;
  let contentBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    let children: Dirent[];
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect workspace state at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1;
      if (visited > maxEntries) throw new Error(`Workspace state exceeds ${String(maxEntries)} entries.`);
      // 跳过符号链接：跟随可能走出工作区，也可能形成环。
      if (child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      if (!relative || isIgnoredPath(relative, ignore)) continue;
      if (child.isDirectory()) {
        if (!ignoredDirectoryNames.has(child.name)) await visit(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const stat = await fs.stat(absolute);
      // 内容预算用完后不再读文件，但仍把路径和大小计入指纹：大小变化依然能被发现，
      // 只是内容级改动看不出来，比整体失败更实用。
      if (contentBytes + stat.size > maxContentBytes) {
        entries.push(`${relative}\0${String(stat.size)}\0content-budget-exhausted`);
        continue;
      }
      const content = await fs.readFile(absolute);
      contentBytes += content.length;
      entries.push(`${relative}\0${String(stat.size)}\0${createHash("sha256").update(content).digest("hex")}`);
    }
  };
  await visit(root);
  return `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}
