/**
 * Session 存储定位模块。
 *
 * 全局项目 session 目录以及 `.biny` 内其余运行目录的创建、session 文件名生成、latest
 * 解析和 session id 前缀匹配都在这里处理。命令层只需要给出 workspace 和可选 session
 * 参数，不必关心文件布局。
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, realpathSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { globalAgentDir, projectSessionsDir } from "../config/paths.js";
import { readSessionTail } from "./limits.js";

const sessionMetadataConcurrency = 8;
const managedStateDirectories = ["attachments", "logs", "runs", "tasks", "processes", "tool-results", "todos", "turns", "evals"] as const;
const legacyStateDirectories = new Set([...managedStateDirectories, "memory"]);
const legacyStateFiles = new Set(["input-history.jsonl", "telemetry.jsonl", "checkpoints.json"]);

interface PathIdentity {
  path: string;
  device: number;
  inode: number;
}

interface SessionStorageLocation {
  workspace: PathIdentity;
  global: PathIdentity;
  globalSessions: PathIdentity;
  sessions: PathIdentity;
}

export interface SessionFileSnapshot {
  filePath: string;
  fileName: string;
  bytes: Buffer;
  stat: Stats;
  /** 文件超过大小上限、只读回了尾部时为 true。 */
  truncated: boolean;
}

export interface SessionDeleteHooks {
  beforeTombstoneMove?(paths: { filePath: string; tombstonePath: string }): Promise<void>;
  afterTombstoneVerified?(paths: { filePath: string; tombstonePath: string }): Promise<void>;
}

export function agentDir(workspaceRoot: string): string {
  // `.biny` 承载项目配置和除 session JSONL 之外的运行状态。
  return path.join(workspaceRoot, ".biny");
}

export async function ensureAgentDirs(workspaceRoot: string): Promise<void> {
  // Parent-directory symlinks would make a seemingly local session write escape
  // the persistence root even when the final file itself uses O_NOFOLLOW.
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const agentPath = path.join(canonicalWorkspace, ".biny");
  await ensureRealDirectory(agentPath, ".biny");
  const canonicalAgent = await fs.realpath(agentPath);
  if (canonicalAgent !== path.join(canonicalWorkspace, ".biny")) {
    throw new Error("Session storage .biny resolves outside the canonical persistence root.");
  }
  for (const name of managedStateDirectories) {
    const directory = path.join(agentPath, name);
    await ensureRealDirectory(directory, `.biny/${name}`);
    if (await fs.realpath(directory) !== path.join(canonicalAgent, name)) {
      throw new Error(`Session storage .biny/${name} resolves outside the canonical .biny directory.`);
    }
  }
  await ensureProjectSessionStorage(canonicalWorkspace);
  await migrateLegacyAgentState(canonicalWorkspace, canonicalAgent);
}

/**
 * 旧版把运行状态放在 `.agent`。首次打开时只复制普通文件和真实目录，绝不覆盖 `.biny`
 * 中已有的新数据，也不跟随旧目录里的软链接，避免迁移把写入边界带到工作区之外。
 */
async function migrateLegacyAgentState(workspaceRoot: string, targetRoot: string): Promise<void> {
  const legacyRoot = path.join(workspaceRoot, ".agent");
  let legacy: import("node:fs").Stats;
  try {
    legacy = await fs.lstat(legacyRoot);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (!legacy.isDirectory() || legacy.isSymbolicLink()) return;
  await copyMissingLegacyEntries(legacyRoot, targetRoot);
}

async function copyMissingLegacyEntries(source: string, target: string, root = true): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    // 只迁移 Biny 自己生成的状态。技能、具名 agent 等旧扩展目录仍由兼容路径只读加载，
    // 不能因为一次运行状态迁移顺手复制用户任意目录。
    if (root && !legacyStateDirectories.has(entry.name) && !legacyStateFiles.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const sourceStat = await fs.lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) continue;
    if (sourceStat.isDirectory()) {
      if (!await ensureMissingMigrationDirectory(targetPath)) continue;
      await copyMissingLegacyEntries(sourcePath, targetPath, false);
      continue;
    }
    if (!sourceStat.isFile()) continue;
    try {
      await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

/** 迁移只会进入自己创建的目录或已有真实目录；未知软链接一律跳过，不把旧状态写到工作区外。 */
async function ensureMissingMigrationDirectory(directory: string): Promise<boolean> {
  try {
    const existing = await fs.lstat(directory);
    return existing.isDirectory() && !existing.isSymbolicLink();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await fs.mkdir(directory, { mode: 0o700 });
  const created = await fs.lstat(directory);
  return created.isDirectory() && !created.isSymbolicLink();
}

export function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  // sessionId 不带扩展名，落盘时统一追加 .jsonl。
  if (
    !sessionId
    || sessionId === "."
    || sessionId === ".."
    || sessionId.includes("\0")
    || sessionId.includes("/")
    || sessionId.includes("\\")
    || sessionId.endsWith(".jsonl")
  ) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const canonicalWorkspace = realpathSync(path.resolve(workspaceRoot));
  return path.join(projectSessionsDir(canonicalWorkspace), `${sessionId}.jsonl`);
}

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

export async function listSessionFiles(workspaceRoot: string): Promise<string[]> {
  // 只列出 JSONL session，避免 logs 或临时文件混进恢复列表。
  const location = await resolveSessionStorage(workspaceRoot);
  return await listSessionFilesInDirectory(location);
}

export async function resolveSessionFile(workspaceRoot: string, session: string | undefined): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  return await resolveSessionFileAt(location, session);
}

export async function readSessionSnapshot(workspaceRoot: string, session: string | undefined): Promise<SessionFileSnapshot> {
  const location = await resolveSessionStorage(workspaceRoot);
  const filePath = await resolveSessionFileAt(location, session);
  return await readSessionSnapshotAt(location, path.basename(filePath));
}

export async function duplicateSessionFile(workspaceRoot: string, sourceSession: string, targetSessionId: string): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  const sourcePath = await resolveSessionFileAt(location, sourceSession);
  const source = await readSessionSnapshotAt(location, path.basename(sourcePath));
  const targetName = path.basename(sessionFilePath(location.workspace.path, targetSessionId));
  const targetPath = path.join(location.sessions.path, targetName);
  let handle: FileHandle | undefined;
  let identity: Pick<Stats, "dev" | "ino"> | undefined;
  let completed = false;
  try {
    await assertSessionStorage(location);
    handle = await fs.open(targetPath, writeNewFlags(), 0o600);
    const stat = await assertSessionBinding(location, targetName, handle);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.chmod(0o600);
    await handle.writeFile(source.bytes);
    await handle.sync();
    await assertSessionBinding(location, targetName, handle);
    completed = true;
    return targetPath;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!completed && identity) await removeBoundSessionFile(location, targetName, identity);
  }
}

export async function createSessionFile(workspaceRoot: string, targetSessionId: string, bytes: Uint8Array): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  const targetName = path.basename(sessionFilePath(location.workspace.path, targetSessionId));
  let handle: FileHandle | undefined;
  let identity: Pick<Stats, "dev" | "ino"> | undefined;
  let completed = false;
  try {
    await assertSessionStorage(location);
    handle = await fs.open(path.join(location.sessions.path, targetName), writeNewFlags(), 0o600);
    const stat = await assertSessionBinding(location, targetName, handle);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await assertSessionBinding(location, targetName, handle);
    completed = true;
    return path.join(location.sessions.path, targetName);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!completed && identity) await removeBoundSessionFile(location, targetName, identity);
  }
}

export async function deleteSessionFile(
  workspaceRoot: string,
  session: string,
  hooks: SessionDeleteHooks = {}
): Promise<void> {
  const location = await resolveSessionStorage(workspaceRoot);
  const filePath = await resolveSessionFileAt(location, session);
  const fileName = path.basename(filePath);
  const handle = await openSessionHandle(location, fileName, true);
  const tombstoneName = sessionDeleteTombstoneName();
  const tombstonePath = path.join(location.sessions.path, tombstoneName);
  try {
    const stat = await assertSessionBinding(location, fileName, handle);
    const identity = { dev: stat.dev, ino: stat.ino };
    await assertSessionStorage(location);
    await assertSessionBinding(location, fileName, handle);
    await hooks.beforeTombstoneMove?.({ filePath, tombstonePath });
    await fs.rename(filePath, tombstonePath);
    const pinned = await isHandleBoundToPath(location, tombstoneName, handle, identity);
    if (!pinned) {
      const restored = await preserveUnexpectedTombstone(location, tombstoneName, fileName);
      const recovery = restored
        ? ` A recovery copy was restored to ${fileName}; the moved file remains preserved as ${tombstoneName}.`
        : ` The moved file remains preserved as ${tombstoneName}.`;
      throw new Error(`Session changed during deletion; no replacement file was unlinked.${recovery}`);
    }
    await hooks.afterTombstoneVerified?.({ filePath, tombstonePath });
    await handle.truncate(0);
    await handle.sync();
    const deletedStat = await handle.stat();
    if (deletedStat.dev !== identity.dev || deletedStat.ino !== identity.ino || deletedStat.size !== 0) {
      throw new Error(`Session deletion could not verify the removed identity: ${fileName}`);
    }
    await assertSessionStorage(location);
  } finally {
    await handle.close();
  }
}

async function resolveSessionFileAt(location: SessionStorageLocation, session: string | undefined): Promise<string> {
  // resume 不传参数，或输入 latest/lates/lat 这类前缀时，都读取最近修改的 session。
  if (!session || isLatestAlias(session)) {
    return await latestSessionFile(location);
  }

  const explicitFileName = explicitSessionFileName(session);
  if (explicitFileName) {
    const filePath = await existingSessionFile(location, explicitFileName);
    if (filePath) return filePath;
    throw new Error(`Session file not found: ${explicitFileName}`);
  }

  if (session.includes("\0") || session.includes("/") || session.includes("\\") || session === "." || session === "..") {
    throw new Error(`Invalid session reference: ${session}`);
  }

  const exact = await existingSessionFile(location, `${session}.jsonl`);
  if (exact) return exact;

  const sessions = await listSessionFilesInDirectory(location);
  const prefixMatches = sessions.filter((fileName) => fileName.startsWith(session));
  // 支持用 session id 前缀恢复，减少复制完整文件名的成本；如果前缀不唯一就明确报错。
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0];
    if (!match) throw new Error(`Session not found: ${session}`);
    const filePath = await existingSessionFile(location, match);
    if (!filePath) throw new Error(`Session not found: ${session}`);
    return filePath;
  }

  if (prefixMatches.length > 1) {
    throw new Error(`Session id is ambiguous: ${session}\nMatches:\n${prefixMatches.join("\n")}`);
  }

  throw new Error(`Session not found: ${session}\nUse "biny sessions" to list sessions, or "biny resume latest" for the latest session.`);
}

async function latestSessionFile(location: SessionStorageLocation): Promise<string> {
  // latest 基于修改时间而不是文件名，能覆盖恢复后继续追加的旧 session。
  const sessions = await listSessionFilesInDirectory(location);
  if (!sessions.length) throw new Error("No sessions found for the current project.");
  const stats: Array<{ fileName: string; filePath: string; mtimeMs: number } | undefined> = new Array(sessions.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(sessionMetadataConcurrency, sessions.length) }, async () => {
    while (nextIndex < sessions.length) {
      const index = nextIndex;
      nextIndex += 1;
      const fileName = sessions[index];
      if (!fileName) continue;
      const filePath = await existingSessionFile(location, fileName);
      if (!filePath) throw new Error(`Session file disappeared during resolution: ${fileName}`);
      const handle = await openSessionHandle(location, fileName);
      let stat: Stats;
      try {
        stat = await assertSessionBinding(location, fileName, handle);
      } finally {
        await handle.close();
      }
      stats[index] = stat.size > 0 ? { fileName, filePath, mtimeMs: stat.mtimeMs } : undefined;
    }
  });
  await Promise.all(workers);
  // 按 mtime 判断 latest，避免同一秒创建多个 session 时文件名排序不准确。
  const nonEmpty = stats.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  nonEmpty.sort((a, b) => a.mtimeMs - b.mtimeMs || a.fileName.localeCompare(b.fileName));
  const latest = nonEmpty.at(-1);
  if (!latest) throw new Error("No sessions found for the current project.");
  return latest.filePath;
}

function isLatestAlias(session: string): boolean {
  // 允许 lat/lates/latest 这类前缀，兼顾命令行输入效率和可读性。
  return "latest".startsWith(session) && session.length >= 3;
}

async function resolveSessionStorage(workspaceRoot: string): Promise<SessionStorageLocation> {
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const globalPath = await fs.realpath(globalAgentDir());
  const globalSessionsPath = path.join(globalPath, "sessions");
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  const [workspaceStat, globalStat, globalSessionsStat, sessionsStat] = await Promise.all([
    fs.lstat(canonicalWorkspace),
    fs.lstat(globalPath),
    fs.lstat(globalSessionsPath),
    fs.lstat(sessionsPath)
  ]);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("Session persistence root must be a real directory.");
  }
  if (globalStat.isSymbolicLink() || !globalStat.isDirectory()) {
    throw new Error("Global session storage must be a real directory, not a symbolic link.");
  }
  if (globalSessionsStat.isSymbolicLink() || !globalSessionsStat.isDirectory()) {
    throw new Error("Global project sessions root must be a real directory, not a symbolic link.");
  }
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Project session storage must be a real directory, not a symbolic link.");
  }

  const canonicalSessions = await fs.realpath(sessionsPath);
  const expectedSessions = projectSessionsDir(canonicalWorkspace);
  if (canonicalSessions !== expectedSessions) {
    throw new Error("Session storage resolves outside the current project's global session directory.");
  }
  return {
    workspace: { path: canonicalWorkspace, device: workspaceStat.dev, inode: workspaceStat.ino },
    global: { path: globalPath, device: globalStat.dev, inode: globalStat.ino },
    globalSessions: { path: globalSessionsPath, device: globalSessionsStat.dev, inode: globalSessionsStat.ino },
    sessions: { path: canonicalSessions, device: sessionsStat.dev, inode: sessionsStat.ino }
  };
}

async function ensureProjectSessionStorage(canonicalWorkspace: string): Promise<void> {
  const configuredGlobal = path.resolve(globalAgentDir());
  await fs.mkdir(configuredGlobal, { recursive: true, mode: 0o700 });
  const canonicalGlobal = await fs.realpath(configuredGlobal);
  const globalSessionsPath = path.join(canonicalGlobal, "sessions");
  await ensureRealDirectory(globalSessionsPath, "global sessions");
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  await ensureRealDirectory(sessionsPath, "current project sessions");
  if (await fs.realpath(sessionsPath) !== sessionsPath) {
    throw new Error("Project session storage resolves outside the global sessions directory.");
  }
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Session storage ${label} must be a real directory, not a symbolic link.`);
  }
  await fs.chmod(directory, 0o700);
}

async function listSessionFilesInDirectory(location: SessionStorageLocation): Promise<string[]> {
  await assertSessionStorage(location);
  const entries = await fs.readdir(location.sessions.path, { withFileTypes: true });
  const safeFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionFileName(entry.name)) continue;
    if (await existingSessionFile(location, entry.name)) safeFiles.push(entry.name);
  }
  await assertSessionStorage(location);
  return safeFiles.sort();
}

async function existingSessionFile(location: SessionStorageLocation, fileName: string): Promise<string | undefined> {
  if (!isSessionFileName(fileName)) throw new Error(`Invalid session file name: ${fileName}`);
  await assertSessionStorage(location);
  const filePath = path.join(location.sessions.path, fileName);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw unsafeSessionError(fileName);
  }

  const canonicalFile = await fs.realpath(filePath);
  if (path.dirname(canonicalFile) !== location.sessions.path || path.basename(canonicalFile) !== fileName) {
    throw new Error(`Session resolves outside the current project's global session directory: ${fileName}`);
  }
  await assertSessionStorage(location);
  return canonicalFile;
}

async function readSessionSnapshotAt(location: SessionStorageLocation, fileName: string): Promise<SessionFileSnapshot> {
  const handle = await openSessionHandle(location, fileName);
  try {
    await assertSessionBinding(location, fileName, handle);
    // 超限时读尾部而不是抛错：否则一条很长的会话就彻底打不开，而用户是在想恢复它的时候
    // 才发现的。`truncated` 让调用方能如实告知只拿到了最近的部分。
    const { bytes, truncated } = await readSessionTail(handle, fileName);
    const stat = await assertSessionBinding(location, fileName, handle);
    return { filePath: path.join(location.sessions.path, fileName), fileName, bytes, stat, truncated };
  } finally {
    await handle.close();
  }
}

async function openSessionHandle(location: SessionStorageLocation, fileName: string, writable = false): Promise<FileHandle> {
  if (!isSessionFileName(fileName)) throw new Error(`Invalid session file name: ${fileName}`);
  await assertSessionStorage(location);
  const filePath = path.join(location.sessions.path, fileName);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw unsafeSessionError(fileName);
    throw error;
  }
  try {
    await assertSessionBinding(location, fileName, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSessionBinding(location: SessionStorageLocation, fileName: string, handle: FileHandle): Promise<Stats> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeSessionError(fileName);
  await assertSessionStorage(location);
  const pathStat = await fs.lstat(path.join(location.sessions.path, fileName));
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeSessionError(fileName);
  }
  return descriptorStat;
}

async function assertSessionStorage(location: SessionStorageLocation): Promise<void> {
  await assertPathIdentity(location.workspace, "Session persistence root changed during access.");
  await assertPathIdentity(location.global, "Global session storage changed during access.");
  await assertPathIdentity(location.globalSessions, "Global project sessions root changed during access.");
  await assertPathIdentity(location.sessions, "Project session storage changed during access.");
  if (
    await fs.realpath(location.global.path) !== location.global.path
    || await fs.realpath(location.globalSessions.path) !== location.globalSessions.path
    || await fs.realpath(location.sessions.path) !== location.sessions.path
  ) {
    throw new Error("Session storage changed during access.");
  }
}

async function assertPathIdentity(identity: PathIdentity, message: string): Promise<void> {
  const stat = await fs.lstat(identity.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error(message);
  }
}

async function isBoundSessionFile(
  location: SessionStorageLocation,
  fileName: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const stat = await fs.lstat(path.join(location.sessions.path, fileName));
    return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

async function isHandleBoundToPath(
  location: SessionStorageLocation,
  fileName: string,
  handle: FileHandle,
  identity: Pick<Stats, "dev" | "ino">
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const [descriptorStat, pathStat] = await Promise.all([
      handle.stat(),
      fs.lstat(path.join(location.sessions.path, fileName))
    ]);
    return descriptorStat.isFile()
      && descriptorStat.nlink === 1
      && descriptorStat.dev === identity.dev
      && descriptorStat.ino === identity.ino
      && !pathStat.isSymbolicLink()
      && pathStat.isFile()
      && pathStat.nlink === 1
      && pathStat.dev === identity.dev
      && pathStat.ino === identity.ino;
  } catch {
    return false;
  }
}

async function preserveUnexpectedTombstone(
  location: SessionStorageLocation,
  tombstoneName: string,
  originalName: string
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const tombstonePath = path.join(location.sessions.path, tombstoneName);
    const stat = await fs.lstat(tombstonePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    await fs.copyFile(
      tombstonePath,
      path.join(location.sessions.path, originalName),
      constants.COPYFILE_EXCL
    );
    await assertSessionStorage(location);
    return true;
  } catch {
    // Never overwrite a path that appeared after the tombstone move. The
    // unpredictable tombstone remains as the recovery artifact in every case.
    return false;
  }
}

async function removeBoundSessionFile(
  location: SessionStorageLocation,
  fileName: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<void> {
  if (!await isBoundSessionFile(location, fileName, identity)) return;
  await fs.unlink(path.join(location.sessions.path, fileName));
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
}

function sessionDeleteTombstoneName(): string {
  return `.session-delete-${randomBytes(16).toString("hex")}.delete`;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function unsafeSessionError(fileName: string): Error {
  return new Error(`Session must be a single-link regular .jsonl file, not a symbolic link, hardlink, or directory: ${fileName}`);
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function explicitSessionFileName(session: string): string | undefined {
  if (path.isAbsolute(session) || session.includes("\0")) {
    throw new Error(`Invalid session reference: ${session}`);
  }
  const segments = session.split(/[\\/]+/u);
  if (segments.includes("..")) throw new Error(`Invalid session reference: ${session}`);

  if (!session.includes("/") && !session.includes("\\")) {
    if (!session.endsWith(".jsonl")) return undefined;
    if (!isSessionFileName(session)) throw new Error(`Invalid session reference: ${session}`);
    return session;
  }

  throw new Error(`Invalid session reference: ${session}`);
}

function isSessionFileName(fileName: string): boolean {
  return fileName.length > ".jsonl".length
    && fileName.endsWith(".jsonl")
    && path.basename(fileName) === fileName
    && !fileName.includes("\0")
    && !fileName.includes("\\");
}
