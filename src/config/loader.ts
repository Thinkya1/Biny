/**
 * Configuration loading and persistence.
 *
 * agent.config.json may contain API credentials, so every read/write pins a
 * single-link regular file under the canonical workspace and enforces 0600.
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { configSchema, defaultConfig, type AgentConfig } from "./schema.js";

export const CONFIG_FILE = "agent.config.json";
export const maxConfigFileBytes = 1024 * 1024;

interface ConfigLocation {
  root: string;
  filePath: string;
  device: number;
  inode: number;
}

export async function loadConfig(workspaceRoot: string): Promise<AgentConfig> {
  const location = await resolveConfigLocation(workspaceRoot);
  let handle: FileHandle | undefined;
  try {
    handle = await openExistingConfig(location);
    await handle.chmod(0o600);
    const raw = await readBoundedConfig(location, handle);
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return configSchema.parse(defaultConfig);
    throw new Error(`Failed to load ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
}

export async function saveConfig(workspaceRoot: string, config: AgentConfig): Promise<void> {
  const parsed = configSchema.parse(config);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxConfigFileBytes) {
    throw new Error(`${CONFIG_FILE} exceeds the ${String(maxConfigFileBytes)}-byte size limit.`);
  }
  const location = await resolveConfigLocation(workspaceRoot);
  await validateOptionalExistingConfig(location, true);
  const temporaryPath = path.join(
    location.root,
    `${CONFIG_FILE}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  try {
    handle = await fs.open(temporaryPath, writeNewFlags(), 0o600);
    const temporaryStat = await assertTemporaryConfigBinding(location, temporaryPath, handle);
    temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    await handle.writeFile(serialized, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await assertTemporaryConfigBinding(location, temporaryPath, handle);
    await assertConfigRoot(location);
    await validateOptionalExistingConfig(location, false);
    await fs.rename(temporaryPath, location.filePath);
    await assertConfigBinding(location, handle);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) await removeBoundTemporaryConfig(location, temporaryPath, temporaryIdentity);
  }
}

export async function ensureConfig(workspaceRoot: string): Promise<void> {
  const location = await resolveConfigLocation(workspaceRoot);
  let existing: FileHandle | undefined;
  try {
    existing = await openExistingConfig(location);
    await existing.chmod(0o600);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await existing?.close();
  }

  let created: FileHandle | undefined;
  try {
    await assertConfigRoot(location);
    created = await fs.open(location.filePath, writeNewFlags(), 0o600);
    await assertConfigBinding(location, created);
    await created.writeFile(`${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    await created.chmod(0o600);
    await created.sync();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const raced = await openExistingConfig(location);
    try {
      await raced.chmod(0o600);
    } finally {
      await raced.close();
    }
  } finally {
    await created?.close();
  }
}

async function resolveConfigLocation(workspaceRoot: string): Promise<ConfigLocation> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Configuration root must be a real directory.");
  }
  return { root, filePath: path.join(root, CONFIG_FILE), device: stat.dev, inode: stat.ino };
}

async function openExistingConfig(location: ConfigLocation): Promise<FileHandle> {
  await assertConfigRoot(location);
  await assertSafeConfigLeaf(location.filePath);
  let handle: FileHandle;
  try {
    handle = await fs.open(location.filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw unsafeConfigError();
    throw error;
  }
  try {
    await assertConfigBinding(location, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateOptionalExistingConfig(location: ConfigLocation, tightenMode: boolean): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openExistingConfig(location);
    if (tightenMode) await handle.chmod(0o600);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function assertConfigRoot(location: ConfigLocation): Promise<void> {
  const stat = await fs.lstat(location.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== location.device || stat.ino !== location.inode) {
    throw new Error("Configuration root changed during access.");
  }
}

async function assertSafeConfigLeaf(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw unsafeConfigError();
}

async function assertConfigBinding(location: ConfigLocation, handle: FileHandle): Promise<Stats> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeConfigError();
  await assertConfigRoot(location);
  const pathStat = await fs.lstat(location.filePath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeConfigError();
  }
  return descriptorStat;
}

async function readBoundedConfig(location: ConfigLocation, handle: FileHandle): Promise<string> {
  const initial = await assertConfigBinding(location, handle);
  if (initial.size > maxConfigFileBytes) throw configSizeError(initial.size);

  const chunks: Buffer[] = [];
  const readLimit = maxConfigFileBytes + 1;
  let bytesRead = 0;
  while (bytesRead < readLimit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - bytesRead));
    const result = await handle.read(chunk, 0, chunk.length, bytesRead);
    if (result.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }

  const current = await assertConfigBinding(location, handle);
  if (!sameConfigSnapshot(initial, current)) {
    throw new Error(`${CONFIG_FILE} changed while it was being read.`);
  }
  if (bytesRead > maxConfigFileBytes || current.size > maxConfigFileBytes) {
    throw configSizeError(Math.max(bytesRead, current.size));
  }
  return Buffer.concat(chunks, bytesRead).toString("utf8");
}

function sameConfigSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function configSizeError(actualBytes: number): Error {
  return new Error(`${CONFIG_FILE} is ${String(actualBytes)} bytes, exceeding the ${String(maxConfigFileBytes)}-byte size limit.`);
}

async function assertTemporaryConfigBinding(
  location: ConfigLocation,
  temporaryPath: string,
  handle: FileHandle
): Promise<Stats> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeConfigError();
  await assertConfigRoot(location);
  const pathStat = await fs.lstat(temporaryPath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeConfigError();
  }
  return descriptorStat;
}

async function removeBoundTemporaryConfig(
  location: ConfigLocation,
  temporaryPath: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<void> {
  try {
    await assertConfigRoot(location);
    const stat = await fs.lstat(temporaryPath);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino) {
      await fs.unlink(temporaryPath);
    }
  } catch {
    // Missing, renamed, or replaced temporary files are never cleanup targets.
  }
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function unsafeConfigError(): Error {
  return new Error(`${CONFIG_FILE} must be a single-link regular file, not a symbolic link or hardlink.`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
