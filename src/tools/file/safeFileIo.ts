import { randomBytes } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const maxReadFileBytes = 1024 * 1024;
export const maxEditFileBytes = 1024 * 1024;
export const maxSearchFileBytes = 1024 * 1024;

export interface FileSnapshot {
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  links: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

export interface BoundedFileRead {
  content: string;
  truncated: boolean;
  snapshot: FileSnapshot;
}

export class FileReadLimitError extends Error {
  constructor(readonly actualBytes: bigint, readonly maxBytes: number) {
    super(`File is ${String(actualBytes)} bytes, exceeding the ${String(maxBytes)}-byte read limit.`);
    this.name = "FileReadLimitError";
  }
}

export async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number,
  overflow: "reject" | "truncate",
  signal?: AbortSignal
): Promise<BoundedFileRead> {
  signal?.throwIfAborted();
  const handle = await openBoundRegularFile(filePath);
  try {
    const initial = await assertFileBinding(filePath, handle);
    if (overflow === "reject" && initial.size > BigInt(maxBytes)) {
      throw new FileReadLimitError(initial.size, maxBytes);
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    const readLimit = maxBytes + 1;
    while (bytesRead < readLimit) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      signal?.throwIfAborted();
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }

    const current = await assertFileBinding(filePath, handle);
    if (!sameFileSnapshot(initial, current)) throw new Error("File changed while it was being read.");
    const truncated = bytesRead > maxBytes || current.size > BigInt(maxBytes);
    if (overflow === "reject" && truncated) {
      throw new FileReadLimitError(current.size > BigInt(bytesRead) ? current.size : BigInt(bytesRead), maxBytes);
    }
    return {
      content: Buffer.concat(chunks, bytesRead).subarray(0, maxBytes).toString("utf8"),
      truncated,
      snapshot: current
    };
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileForEdit(filePath: string, signal?: AbortSignal): Promise<{ content: string; snapshot: FileSnapshot }> {
  const result = await readBoundedUtf8File(filePath, maxEditFileBytes, "reject", signal);
  return { content: result.content, snapshot: result.snapshot };
}

export async function atomicWriteUtf8File(
  filePath: string,
  content: string,
  expectedSnapshot: FileSnapshot | null | undefined,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const directory = path.dirname(filePath);
  let directorySnapshot: FileIdentity;
  try {
    directorySnapshot = await snapshotDirectory(directory);
  } catch (error) {
    if (isNotFound(error)) throw new Error("The target parent directory must already exist.");
    throw error;
  }
  const currentTarget = await snapshotTarget(filePath);
  const targetSnapshot = expectedSnapshot === undefined ? currentTarget : expectedSnapshot;
  if (!sameOptionalFileSnapshot(targetSnapshot, currentTarget)) {
    throw new Error("The target file changed before the atomic write started.");
  }

  const temporaryPath = path.join(
    directory,
    `.biny-write-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
  );
  let backupPath: string | undefined;
  let backupSnapshot: FileSnapshot | undefined;
  let handle: FileHandle | undefined;
  let temporarySnapshot: FileSnapshot | undefined;
  let committed = false;
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    handle = await fs.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      targetSnapshot ? Number(targetSnapshot.mode & 0o777n) : 0o666
    );
    temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
    if (targetSnapshot) await handle.chmod(Number(targetSnapshot.mode & 0o777n));
    signal?.throwIfAborted();
    await handle.writeFile(content, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
    temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
    await assertDirectoryBinding(directory, directorySnapshot);
    const targetBeforeCommit = await snapshotTarget(filePath);
    if (!sameOptionalFileSnapshot(targetSnapshot, targetBeforeCommit)) {
      throw new Error("The target file changed before the atomic write could be committed.");
    }
    signal?.throwIfAborted();

    if (targetSnapshot === null) {
      // Linking is an atomic no-replace commit for a new target. Unlike rename,
      // it cannot clobber a file created after the last snapshot check.
      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error("The target file appeared before the atomic write could be committed.");
        }
        throw error;
      }
      committed = true;
      await fs.unlink(temporaryPath);
      temporarySnapshot = undefined;
    } else {
      // Keep the approved inode reachable across rename. If another process
      // writes through the old path during the commit window, the hardlink lets
      // us detect that mutation and restore its content instead of losing it.
      backupPath = path.join(
        directory,
        `.biny-backup-${String(process.pid)}-${randomBytes(8).toString("hex")}.tmp`
      );
      await fs.link(filePath, backupPath);
      backupSnapshot = await requiredTargetSnapshot(backupPath);
      if (!sameStableFileVersion(targetSnapshot, backupSnapshot)) {
        throw new Error("The target file changed while its approved version was being pinned.");
      }
      signal?.throwIfAborted();

      // rename is the commit point for an existing target. Cancellation after
      // this call must not turn a completed replacement into a pre-commit abort.
      await fs.rename(temporaryPath, filePath);
      temporarySnapshot = undefined;
      committed = true;
      const displacedSnapshot = await requiredTargetSnapshot(backupPath);
      backupSnapshot = displacedSnapshot;
      if (!sameStableFileVersion(targetSnapshot, displacedSnapshot)) {
        // Only restore while the visible target is still the inode we just
        // committed. If somebody has replaced it again, preserve both files and
        // fail without overwriting that newer external target.
        await assertFileBinding(filePath, handle, true);
        await fs.rename(backupPath, filePath);
        backupPath = undefined;
        backupSnapshot = undefined;
        committed = false;
        throw new Error("The target file changed during the atomic commit and the external version was restored.");
      }
      await fs.unlink(backupPath);
      backupPath = undefined;
      backupSnapshot = undefined;
    }
    await assertFileBinding(filePath, handle, true);
    // The file is already committed here. Directory fsync improves crash
    // durability where supported, but must not report the completed write as a
    // failure on filesystems that reject directory syncing.
    await syncDirectory(directory).catch(() => undefined);
    return Buffer.byteLength(content, "utf8");
  } finally {
    if (!committed && handle && temporarySnapshot) {
      try {
        temporarySnapshot = await assertFileBinding(temporaryPath, handle, true);
      } catch {
        temporarySnapshot = undefined;
      }
    }
    await handle?.close().catch(() => undefined);
    if (!committed && temporarySnapshot) {
      await removeBoundTemporaryFile(directory, directorySnapshot, temporaryPath, temporarySnapshot);
    }
    if (backupPath && backupSnapshot) {
      await removeBoundAuxiliaryFile(directory, directorySnapshot, backupPath, backupSnapshot);
    }
  }
}

async function openBoundRegularFile(filePath: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw new Error("File changed to a symbolic link before it could be opened.");
    throw error;
  }
  try {
    await assertFileBinding(filePath, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertFileBinding(filePath: string, handle: FileHandle, requireSingleLink = false): Promise<FileSnapshot> {
  const descriptorStat = await handle.stat({ bigint: true });
  const pathStat = await fs.lstat(filePath, { bigint: true });
  if (
    !descriptorStat.isFile()
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || (requireSingleLink && (descriptorStat.nlink !== 1n || pathStat.nlink !== 1n))
    || await fs.realpath(filePath) !== path.resolve(filePath)
  ) {
    throw new Error("File path changed during access.");
  }
  return fileSnapshot(descriptorStat);
}

async function snapshotTarget(filePath: string): Promise<FileSnapshot | null> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || await fs.realpath(filePath) !== path.resolve(filePath)) {
      throw new Error("Atomic write target must remain a regular file at its canonical path.");
    }
    return fileSnapshot(stat);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function requiredTargetSnapshot(filePath: string): Promise<FileSnapshot> {
  const snapshot = await snapshotTarget(filePath);
  if (!snapshot) throw new Error("Atomic write auxiliary file disappeared during access.");
  return snapshot;
}

async function snapshotDirectory(directory: string): Promise<FileIdentity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    throw new Error("Atomic write parent must remain a real canonical directory.");
  }
  return { device: stat.dev, inode: stat.ino };
}

async function assertDirectoryBinding(directory: string, expected: FileIdentity): Promise<void> {
  const current = await snapshotDirectory(directory);
  if (!sameIdentity(expected, current)) throw new Error("Atomic write parent directory changed during access.");
}

async function removeBoundTemporaryFile(
  directory: string,
  directorySnapshot: FileIdentity,
  temporaryPath: string,
  temporarySnapshot: FileSnapshot
): Promise<void> {
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    const stat = await fs.lstat(temporaryPath, { bigint: true });
    const current = fileSnapshot(stat);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n && sameFileSnapshot(current, temporarySnapshot)) {
      await fs.unlink(temporaryPath);
    }
  } catch {
    // A missing, renamed, linked, or replaced temporary file is never removed.
  }
}

async function removeBoundAuxiliaryFile(
  directory: string,
  directorySnapshot: FileIdentity,
  auxiliaryPath: string,
  auxiliarySnapshot: FileSnapshot
): Promise<void> {
  try {
    await assertDirectoryBinding(directory, directorySnapshot);
    const current = await requiredTargetSnapshot(auxiliaryPath);
    if (sameFileSnapshot(current, auxiliarySnapshot)) await fs.unlink(auxiliaryPath);
  } catch {
    // Never remove an auxiliary path whose directory or inode changed.
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileSnapshot(stat: BigIntStats): FileSnapshot {
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

export function sameOptionalFileSnapshot(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return sameFileSnapshot(left, right);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.links === right.links
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

function sameStableFileVersion(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mode === right.mode
    && left.modifiedAt === right.modifiedAt;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
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
