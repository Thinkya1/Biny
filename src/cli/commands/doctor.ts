/**
 * 环境诊断命令模块。
 *
 * `doctor` 做轻量本地检查，报告 Node、pnpm、git、配置文件和 `.agent` 目录状态。
 * 它只读取环境，不创建或修改项目文件。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "../../config/loader.js";
import { pathExists } from "../../utils/fs.js";

const execFileAsync = promisify(execFile);

export async function doctorCommand(workspaceRoot: string): Promise<void> {
  // doctor 只做本地环境探测，不创建配置或 session。
  const checks = [
    ["node", process.version],
    ["pnpm", await commandVersion("pnpm", ["--version"])],
    ["git", await commandVersion("git", ["--version"])],
    [CONFIG_FILE, (await pathExists(path.join(workspaceRoot, CONFIG_FILE))) ? "found" : "missing"],
    ["credentials", await credentialStatus(workspaceRoot)],
    [".agent", (await pathExists(path.join(workspaceRoot, ".agent"))) ? "found" : "missing"]
  ];

  for (const [name, result] of checks) {
    console.log(`${name}: ${result}`);
  }
}

async function credentialStatus(workspaceRoot: string): Promise<string> {
  try {
    const config = await loadConfig(workspaceRoot);
    return Object.values(config.providers).some((provider) => Boolean(provider.apiKey))
      ? `warning: inline API key found in ${CONFIG_FILE}; use apiKeyEnv and rotate the key`
      : "no inline API keys";
  } catch (error) {
    return `unable to inspect configuration: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  // 缺失的外部命令以 not available 呈现，避免把 ENOENT 堆栈暴露给用户。
  try {
    const result = await execFileAsync(command, args);
    return result.stdout.trim();
  } catch {
    return "not available";
  }
}
