import { promises as fs } from "node:fs";
import path from "node:path";
import { scanWorkspaceFiles } from "../workspace/scanner.js";
import { pathExists } from "../utils/fs.js";

export async function buildProjectContext(workspaceRoot: string, ignore: string[]): Promise<string> {
  const files = await scanWorkspaceFiles(workspaceRoot, ignore, 80);
  const snippets: string[] = [`Files:\n${files.join("\n")}`];

  for (const candidate of ["package.json", "README.md"]) {
    const absolutePath = path.join(workspaceRoot, candidate);
    if (await pathExists(absolutePath)) {
      const content = await fs.readFile(absolutePath, "utf8");
      snippets.push(`${candidate}:\n${content.slice(0, 4000)}`);
    }
  }

  return snippets.join("\n\n");
}
