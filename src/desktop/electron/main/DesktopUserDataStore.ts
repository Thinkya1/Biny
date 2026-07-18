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
    if (!await exists(legacyPath)) return;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    if (!await exists(destinationPath)) {
      await fs.copyFile(legacyPath, destinationPath);
      return;
    }

    const legacyState = await readJsonRecord(legacyPath);
    const destinationState = await readJsonRecord(destinationPath);
    if (!legacyState || !destinationState) return;

    const mergedState: Record<string, unknown> = {
      ...legacyState,
      ...destinationState,
      projects: mergeProjects(legacyState.projects, destinationState.projects),
      selectedSessionIds: {
        ...recordValue(legacyState.selectedSessionIds),
        ...recordValue(destinationState.selectedSessionIds)
      },
      sessionMetadata: {
        ...recordValue(legacyState.sessionMetadata),
        ...recordValue(destinationState.sessionMetadata)
      }
    };
    if (destinationState.activeProjectId === undefined && legacyState.activeProjectId !== undefined) {
      mergedState.activeProjectId = legacyState.activeProjectId;
    }
    await fs.writeFile(destinationPath, `${JSON.stringify(mergedState, null, 2)}\n`, "utf8");
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
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const legacyAgentDirectory = agentDir(project.path);
    if (await exists(legacyAgentDirectory) && path.resolve(legacyAgentDirectory) !== path.resolve(targetAgentDirectory)) {
      await mergeDirectory(legacyAgentDirectory, targetAgentDirectory);
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

async function mergeDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectory(sourcePath, destinationPath);
    } else if (entry.isFile() && !await exists(destinationPath)) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function mergeProjects(legacy: unknown, destination: unknown): unknown[] {
  const projects = new Map<string, unknown>();
  for (const project of Array.isArray(legacy) ? legacy : []) {
    const key = projectKey(project);
    if (key) projects.set(key, project);
  }
  for (const project of Array.isArray(destination) ? destination : []) {
    const key = projectKey(project);
    if (key) projects.set(key, project);
  }
  return [...projects.values()];
}

function projectKey(project: unknown): string | undefined {
  if (!isRecord(project)) return undefined;
  if (typeof project.id === "string") return `id:${project.id}`;
  if (typeof project.path === "string") return `path:${project.path}`;
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
