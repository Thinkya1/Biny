import { promises as fs } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "./ignore.js";

export async function scanWorkspaceFiles(workspaceRoot: string, ignore: string[], limit = 200): Promise<string[]> {
  const files: string[] = [];
  await walk(workspaceRoot, "");
  return files;

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    if (files.length >= limit) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (isIgnoredPath(relativePath, ignore)) continue;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
}
