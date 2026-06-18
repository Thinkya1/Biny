import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CONFIG_FILE } from "../../config/loader.js";
import { pathExists } from "../../utils/fs.js";

const execFileAsync = promisify(execFile);

export async function doctorCommand(workspaceRoot: string): Promise<void> {
  const checks = [
    ["node", process.version],
    ["pnpm", await commandVersion("pnpm", ["--version"])],
    ["git", await commandVersion("git", ["--version"])],
    [CONFIG_FILE, (await pathExists(path.join(workspaceRoot, CONFIG_FILE))) ? "found" : "missing"],
    [".agent", (await pathExists(path.join(workspaceRoot, ".agent"))) ? "found" : "missing"]
  ];

  for (const [name, result] of checks) {
    console.log(`${name}: ${result}`);
  }
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, args);
    return result.stdout.trim();
  } catch {
    return "not available";
  }
}
