import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "../workspace/ignore.js";

const ignoredDirectoryNames = new Set([".agent", ".git", "node_modules", "dist", "build", "out", "target", "coverage"]);
const maxEntries = 20_000;
const maxContentBytes = 64 * 1024 * 1024;

/** Bounded digest over workspace files, excluding runtime/build output. */
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
