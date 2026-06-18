import { ensureConfig } from "../../config/loader.js";
import { ensureAgentDirs } from "../../session/store.js";

export async function initCommand(workspaceRoot: string): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  await ensureConfig(workspaceRoot);
  console.log("Initialized agent config and .agent directories.");
}
