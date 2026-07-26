/**
 * Session 文件的大小上限与有界读取。
 *
 * session 是本地 JSONL，可能被外部程序写坏或写到极大，直接整体读入会打爆内存，所以
 * 读取和回放统一走这里的上限检查。
 */
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const maxSessionFileBytes = 16 * 1024 * 1024;
export const maxSessionEventLineBytes = 1024 * 1024;
export const maxSessionEvents = 50_000;

const sessionReadChunkBytes = 64 * 1024;

/** 接近上限的比例；越过就该提醒用户分叉，而不是等撞上再说。 */
export const sessionSizeWarningRatio = 0.8;

export interface BoundedSessionRead {
  bytes: Buffer;
  /** 文件超限、只读回了尾部时为 true。 */
  truncated: boolean;
}

export function isSessionNearLimit(sizeBytes: number, events: number): boolean {
  return sizeBytes > maxSessionFileBytes * sessionSizeWarningRatio
    || events > maxSessionEvents * sessionSizeWarningRatio;
}

export function assertSessionFileSize(size: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxSessionFileBytes) {
    throw new Error(`Session exceeds the maximum size of ${String(maxSessionFileBytes)} bytes: ${path.basename(label)}`);
  }
}

/**
 * 分块读完整个 session 文件，并在读前、读中、读后各校验一次大小。
 * 只信任读取前的 stat 是不够的：读的过程中文件仍可能被追加，所以多读一个字节即判超限，
 * 读完后再 stat 一次确认文件没有在期间涨过上限。
 */
export async function readBoundedSessionHandle(handle: FileHandle, label: string): Promise<Buffer> {
  const initialStat = await handle.stat();
  assertSessionFileSize(initialStat.size, label);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxSessionFileBytes) {
    // 故意多留 1 字节的余量：能读到这一字节说明文件已超限，下面的校验会抛错。
    const remaining = maxSessionFileBytes + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(sessionReadChunkBytes, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  assertSessionFileSize(totalBytes, label);
  const finalStat = await handle.stat();
  assertSessionFileSize(finalStat.size, label);
  return Buffer.concat(chunks, totalBytes);
}

/**
 * 超限时读回文件尾部而不是抛错。
 *
 * 严格模式（`readBoundedSessionHandle`）适合校验和写入路径：那里发现异常就该停下。但对
 * "打开一条很长的会话"来说，抛错等于这条会话彻底打不开 —— 而且用户是在想恢复它的时候才
 * 发现的。读尾部至少让最近的历史仍然可用，`truncated` 如实告诉调用方发生了什么。
 *
 * 第一行大概率是从中间截断的，直接丢掉。
 */
export async function readSessionTail(handle: FileHandle, label: string): Promise<BoundedSessionRead> {
  const stat = await handle.stat();
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`Session has an unreadable size: ${path.basename(label)}`);
  }
  if (stat.size <= maxSessionFileBytes) {
    return { bytes: await readBoundedSessionHandle(handle, label), truncated: false };
  }
  const start = stat.size - maxSessionFileBytes;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes < maxSessionFileBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(sessionReadChunkBytes, maxSessionFileBytes - totalBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start + totalBytes);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  const tail = Buffer.concat(chunks, totalBytes);
  const firstNewline = tail.indexOf(0x0a);
  return { bytes: firstNewline === -1 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1), truncated: true };
}
