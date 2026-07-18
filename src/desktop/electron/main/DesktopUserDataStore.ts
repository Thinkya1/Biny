import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "../../../config/loader.js";
import { agentDir } from "../../../session/store.js";
import type { DesktopProject } from "../../protocol.js";
import { DesktopConfigStore } from "./DesktopConfigStore.js";

/** Owns all desktop-generated data below Electron's userData directory. */
export class DesktopUserDataStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  projectRoot(project: DesktopProject): string {
    return path.join(this.root, "projects", projectStorageId(project.id));
  }

  attachmentsRoot(project: DesktopProject): string {
    return path.join(agentDir(this.projectRoot(project)), "attachments");
  }

  async migrateLegacyState(legacyPath: string, destinationPath: string): Promise<void> {
    if (await exists(destinationPath) || !await exists(legacyPath)) return;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(legacyPath, destinationPath);
  }

  async migrateLegacyConfig(projects: DesktopProject[], configStore: DesktopConfigStore): Promise<void> {
    if (await exists(configStore.configPath())) return;
    for (const project of projects) {
      const legacyPath = path.join(project.path, CONFIG_FILE);
      if (!await exists(legacyPath)) continue;
      await configStore.save(await loadConfig(project.path));
      return;
    }
  }

  async ensureProjectData(project: DesktopProject): Promise<string> {
    const targetRoot = this.projectRoot(project);
    const targetAgentDirectory = agentDir(targetRoot);
    if (await exists(targetAgentDirectory)) return targetRoot;
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const legacyAgentDirectory = agentDir(project.path);
    if (await exists(legacyAgentDirectory)) {
      await fs.cp(legacyAgentDirectory, targetAgentDirectory, { recursive: true, force: false, errorOnExist: false });
    }
    return targetRoot;
  }
}

function projectStorageId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
