import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const maxSkillBytes = 32 * 1024;
const maxSkillFiles = 32;

export interface SkillBundle {
  paths: string[];
  prompt: string;
}

interface SkillFileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface SkillFileCandidate {
  path: string;
  snapshot: SkillFileSnapshot;
}

export async function loadSkills(workspaceRoot: string, configuredPaths: string[]): Promise<SkillBundle> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const files: SkillFileCandidate[] = [];
  const seen = new Set<string>();
  for (const configuredPath of configuredPaths) {
    const absolutePath = await resolveWorkspaceSkillPath(canonicalWorkspace, configuredPath);
    if (!absolutePath) continue;
    await collectSkillFiles(canonicalWorkspace, absolutePath, files, seen);
    if (files.length >= maxSkillFiles) break;
  }

  const skills: Array<{ path: string; content: string }> = [];
  let usedBytes = 0;
  for (const candidate of files.sort((left, right) => left.path.localeCompare(right.path))) {
    if (usedBytes >= maxSkillBytes) break;
    try {
      const remaining = maxSkillBytes - usedBytes;
      const selected = await readBoundedSkillFile(canonicalWorkspace, candidate, remaining);
      if (!selected) continue;
      usedBytes += Buffer.byteLength(selected, "utf8");
      skills.push({ path: path.relative(canonicalWorkspace, candidate.path) || path.basename(candidate.path), content: selected });
    } catch {
      // A missing or unreadable optional skill should not stop the runtime.
    }
  }

  return {
    paths: skills.map((skill) => skill.path),
    prompt: skills.map((skill) => `Skill from ${skill.path}:\n${skill.content}`).join("\n\n")
  };
}

async function collectSkillFiles(workspaceRoot: string, target: string, files: SkillFileCandidate[], seen: Set<string>): Promise<void> {
  if (files.length >= maxSkillFiles) return;
  let stat;
  try {
    stat = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`Skill paths cannot contain symbolic links: ${target}`);
  if (await escapesWorkspace(workspaceRoot, target)) throw new Error(`Skill path escapes workspace: ${target}`);
  if (stat.isFile()) {
    if (stat.nlink !== 1n) throw new Error(`Skill files cannot be hardlinks: ${target}`);
    if (path.extname(target).toLowerCase() === ".md" && !seen.has(target)) {
      seen.add(target);
      files.push({ path: target, snapshot: skillSnapshot(stat) });
    }
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
    await collectSkillFiles(workspaceRoot, path.join(target, entry.name), files, seen);
    if (files.length >= maxSkillFiles) return;
  }
}

async function resolveWorkspaceSkillPath(workspaceRoot: string, configuredPath: string): Promise<string | undefined> {
  const absolutePath = path.resolve(workspaceRoot, configuredPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill path must stay inside workspace: ${configuredPath}`);
  }
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Skill paths cannot be symbolic links: ${configuredPath}`);
    const canonical = await fs.realpath(absolutePath);
    if (path.relative(workspaceRoot, canonical).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(workspaceRoot, canonical))) {
      throw new Error(`Skill path escapes workspace: ${configuredPath}`);
    }
    if (canonical !== absolutePath) throw new Error(`Skill paths cannot contain symbolic links: ${configuredPath}`);
    return canonical;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

async function readBoundedSkillFile(workspaceRoot: string, candidate: SkillFileCandidate, maxBytes: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate.path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error(`Skill file changed to a symbolic link before it could be read: ${candidate.path}`);
    throw error;
  }

  try {
    const initial = await assertSkillFileBinding(workspaceRoot, candidate, handle);
    const chunks: Buffer[] = [];
    const readLimit = maxBytes + 4;
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    const current = await assertSkillFileBinding(workspaceRoot, candidate, handle);
    if (!sameSkillSnapshot(initial, current)) throw new Error(`Skill file changed while it was being read: ${candidate.path}`);
    return truncateUtf8(Buffer.concat(chunks, bytesRead).toString("utf8"), maxBytes);
  } finally {
    await handle.close();
  }
}

async function assertSkillFileBinding(
  workspaceRoot: string,
  candidate: SkillFileCandidate,
  handle: FileHandle
): Promise<SkillFileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(candidate.path, { bigint: true });
  const canonical = await fs.realpath(candidate.path);
  const relative = path.relative(workspaceRoot, canonical);
  const snapshot = skillSnapshot(descriptorStat);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1n
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1n
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || canonical !== candidate.path
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !sameSkillSnapshot(candidate.snapshot, snapshot)
  ) {
    throw new Error(`Skill file changed after validation: ${candidate.path}`);
  }
  return snapshot;
}

function skillSnapshot(stat: BigIntStats): SkillFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    links: stat.nlink,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs
  };
}

function sameSkillSnapshot(left: SkillFileSnapshot, right: SkillFileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

async function escapesWorkspace(workspaceRoot: string, target: string): Promise<boolean> {
  const canonical = await fs.realpath(target);
  const relative = path.relative(workspaceRoot, canonical);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
