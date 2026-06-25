/**
 * 旧版项目上下文拼接模块。
 *
 * 这个模块把工作区文件列表和入口文档裁剪成一段纯文本上下文，供早期简单问答流程使用。
 * 新的运行时主要使用 `ProjectContext`，但保留这里可以兼容更轻量的 prompt 组装场景。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanWorkspaceFiles } from "../workspace/scanner.js";
import { pathExists } from "../utils/fs.js";

export async function buildProjectContext(workspaceRoot: string, ignore: string[]): Promise<string> {
  // 旧版上下文构建器只拼文件列表和少量入口文档；新流程主要使用 ProjectContext。
  const files = await scanWorkspaceFiles(workspaceRoot, ignore, 80);
  const snippets: string[] = [`Files:\n${files.join("\n")}`];

  for (const candidate of ["package.json", "README.md"]) {
    const absolutePath = path.join(workspaceRoot, candidate);
    if (await pathExists(absolutePath)) {
      // 每个文档只截取前 4000 字符，防止上下文过大。
      const content = await fs.readFile(absolutePath, "utf8");
      snippets.push(`${candidate}:\n${content.slice(0, 4000)}`);
    }
  }

  return snippets.join("\n\n");
}
