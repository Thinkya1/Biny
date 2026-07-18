import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export const maxSessionFileBytes = 16 * 1024 * 1024;
export const maxSessionEventLineBytes = 1024 * 1024;
export const maxSessionEvents = 50_000;

const sessionReadChunkBytes = 64 * 1024;

export function assertSessionFileSize(size: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxSessionFileBytes) {
    throw new Error(`Session exceeds the maximum size of ${String(maxSessionFileBytes)} bytes: ${path.basename(label)}`);
  }
}

export async function readBoundedSessionHandle(handle: FileHandle, label: string): Promise<Buffer> {
  const initialStat = await handle.stat();
  assertSessionFileSize(initialStat.size, label);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxSessionFileBytes) {
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
