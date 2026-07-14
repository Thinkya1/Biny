import { promises as fs } from "node:fs";
import path from "node:path";

const maxSkillBytes = 32 * 1024;
const maxSkillFiles = 32;

export interface SkillBundle {
  paths: string[];
  prompt: string;
}

export async function loadSkills(workspaceRoot: string, configuredPaths: string[]): Promise<SkillBundle> {
  const files: string[] = [];
  for (const configuredPath of configuredPaths) {
    const absolutePath = resolveWorkspacePath(workspaceRoot, configuredPath);
    if (!absolutePath) continue;
    await collectSkillFiles(absolutePath, files);
    if (files.length >= maxSkillFiles) break;
  }

  const skills: Array<{ path: string; content: string }> = [];
  let usedBytes = 0;
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    if (usedBytes >= maxSkillBytes) break;
    try {
      const content = await fs.readFile(filePath, "utf8");
      const remaining = maxSkillBytes - usedBytes;
      const selected = truncateUtf8(content, remaining);
      if (!selected) continue;
      usedBytes += Buffer.byteLength(selected, "utf8");
      skills.push({ path: path.relative(workspaceRoot, filePath) || path.basename(filePath), content: selected });
    } catch {
      // A missing or unreadable optional skill should not stop the runtime.
    }
  }

  return {
    paths: skills.map((skill) => skill.path),
    prompt: skills.map((skill) => `Skill from ${skill.path}:\n${skill.content}`).join("\n\n")
  };
}

async function collectSkillFiles(target: string, files: string[]): Promise<void> {
  if (files.length >= maxSkillFiles) return;
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (path.extname(target).toLowerCase() === ".md") files.push(target);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    await collectSkillFiles(path.join(target, entry.name), files);
    if (files.length >= maxSkillFiles) return;
  }
}

function resolveWorkspacePath(workspaceRoot: string, configuredPath: string): string | undefined {
  const absolutePath = path.resolve(workspaceRoot, configuredPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? absolutePath : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}
