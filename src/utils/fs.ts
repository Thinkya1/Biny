/**
 * 文件系统辅助模块。
 *
 * 一些跨模块复用的小型 fs 操作集中放在这里：递归创建目录、判断路径是否存在、以及写入格式化
 * JSON。它们不携带 agent 业务语义，只提供稳定的底层工具函数。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  // recursive 让多层目录初始化可重复执行，适合命令启动时兜底创建。
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  // fs.access 比 stat 更轻量，这里只关心路径是否可访问。
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  // 写 JSON 前先确保父目录存在，并统一以两个空格和尾随换行落盘。
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
