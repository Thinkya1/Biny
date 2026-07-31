/**
 * 本地 telemetry 落盘（`.biny/telemetry.jsonl`）。
 *
 * 只写本地文件，不上报任何外部服务。输入/输出是否记录由配置决定，且写入前一律脱敏。
 *
 * 这里的所有失败都被吞掉：telemetry 属于诊断信息，写不进去不能影响产生该事件的实际操作。
 */
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../config/schema.js";
import { agentDir } from "../session/store.js";
import { redactSecrets } from "../utils/secrets.js";
import type { AgentUsage } from "../agent/core/types.js";

/** Record one native model turn without depending on a provider callback contract. */
export async function recordNativeTelemetryEnd(
  config: AgentConfig,
  workspaceRoot: string,
  details: { provider: string; modelId: string; usage?: AgentUsage; text?: string }
): Promise<void> {
  if (!config.telemetry.enabled) return;
  await appendSecureTelemetry(
    path.join(agentDir(workspaceRoot), "telemetry.jsonl"),
    `${JSON.stringify({
      type: "end",
      provider: details.provider,
      modelId: details.modelId,
      usage: sanitizeUsage(details.usage),
      outputs: config.telemetry.recordOutputs ? safePayload(details.text) : undefined,
      time: new Date().toISOString()
    })}\n`
  ).catch(() => undefined);
}

/** 追加一行前先确认目录和文件都是真实的普通文件/目录，不跟随符号链接写到别处。 */
async function appendSecureTelemetry(requestedPath: string, line: string): Promise<void> {
  const requestedDirectory = path.dirname(path.resolve(requestedPath));
  const directoryStat = await fs.lstat(requestedDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Telemetry directory must be a real directory.");
  const directory = await fs.realpath(requestedDirectory);
  const filePath = path.join(directory, path.basename(requestedPath));
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
    throw new Error("Telemetry file must be a single-link regular file.");
  }

  const handle = await fs.open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag(),
    0o600
  );
  try {
    // 打开之后再核对一次：确认句柄指向的 inode 就是路径当前指向的那个，
    // 防止在 lstat 与 open 之间文件被替换（TOCTOU）。
    const descriptorStat = await handle.stat();
    const pathStat = await fs.lstat(filePath);
    if (
      !descriptorStat.isFile()
      || descriptorStat.nlink !== 1
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.nlink !== 1
      || pathStat.dev !== descriptorStat.dev
      || pathStat.ino !== descriptorStat.ino
      || await fs.realpath(requestedDirectory) !== directory
    ) {
      throw new Error("Telemetry storage changed during append.");
    }
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

/** 只挑出确定需要的 token 字段，避免 provider 增加未知字段污染日志。 */
function sanitizeUsage(value: AgentUsage | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    reasoningTokens: value.reasoningTokens
  };
}

/** 输入/输出先截断再脱敏后落盘；序列化不了（循环引用等）就记个占位，不抛错。 */
function safePayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return redactSecrets(JSON.stringify(value).slice(0, 8_000));
  } catch {
    return "[unserializable]";
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
