/**
 * 桌面端专属数据目录（Electron userData 下）：配置、凭据、界面状态、附件，以及不属于任何
 * 项目的会话。
 *
 * 属于项目的 session / run / 记忆仍然放在 `<项目>/.agent` 里，这样同一个工作区在桌面端和
 * TUI 里看到的是同一份历史。
 *
 * 另外承担历史状态和会话迁移；旧模型配置不在启动时自动搬运，避免静默复制凭据。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "../../../session/store.js";
import type { DesktopProject } from "../../protocol.js";
import { DesktopConfigStore } from "./DesktopConfigStore.js";

export class DesktopUserDataStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  /** 项目的桌面端专属目录：附件，以及统一到项目目录之前遗留的会话。 */
  projectDesktopRoot(project: DesktopProject): string {
    return path.join(this.root, "projects", projectStorageId(project.id));
  }

  /** 未关联任何已打开项目的会话存放处。 */
  globalRoot(): string {
    return path.join(this.root, "global");
  }

  attachmentsRoot(project: DesktopProject): string {
    return path.join(agentDir(this.projectDesktopRoot(project)), "attachments");
  }

  /**
   * 迁移旧版桌面状态。目标不存在时直接拷贝；两边都有则按字段合并，
   * 冲突时以新位置为准（`...legacyState, ...destinationState` 的顺序即此意），
   * 项目列表和各类映射表则做并集，避免迁移把用户已有的项目弄丢。
   */
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
    // 配置迁移不再由启动流程自动执行，避免把旧项目凭据静默复制到全局目录；doctor 只负责提示。
    void projects;
    void configStore;
  }

  /**
   * Ensures project session storage lives under the project path and returns that root.
   * One-time migration copies leftover userData project agent files (except attachments)
   * into `<project>/.agent` when the destination file is missing.
   */
  async ensureProjectData(project: DesktopProject): Promise<string> {
    const targetRoot = path.resolve(project.path);
    await ensureAgentDirs(targetRoot);

    const legacyAgentDirectory = agentDir(this.projectDesktopRoot(project));
    const targetAgentDirectory = agentDir(targetRoot);
    if (await exists(legacyAgentDirectory) && path.resolve(legacyAgentDirectory) !== path.resolve(targetAgentDirectory)) {
      await mergeDirectory(legacyAgentDirectory, targetAgentDirectory, new Set(["attachments"]));
    }
    return targetRoot;
  }

  /** Ensures the global (non-project) session root exists and returns it. */
  async ensureGlobalData(): Promise<string> {
    const targetRoot = this.globalRoot();
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await ensureAgentDirs(targetRoot);
    return targetRoot;
  }

  async ensureAttachmentsRoot(project: DesktopProject): Promise<string> {
    const directory = this.attachmentsRoot(project);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
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

async function mergeDirectory(source: string, destination: string, skipNames = new Set<string>()): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
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
