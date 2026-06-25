/**
 * 初始化命令模块。
 *
 * `init` 是一个幂等命令，用来创建 `.agent` 运行目录并在缺失时写入默认配置文件。
 * 已存在的用户配置不会被覆盖。
 */
import { ensureConfig } from "../../config/loader.js";
import { ensureAgentDirs } from "../../session/store.js";

export async function initCommand(workspaceRoot: string): Promise<void> {
  // init 是幂等操作：目录可重复创建，配置文件只在缺失时写入。
  await ensureAgentDirs(workspaceRoot);
  await ensureConfig(workspaceRoot);
  console.log("Initialized agent config and .agent directories.");
}
