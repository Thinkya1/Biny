/**
 * 桌面端专属数据目录（Electron userData 下）：配置、凭据、界面状态，以及不属于任何项目的会话。
 *
 * 属于项目的 session 放在全局项目会话目录；附件、run 和记忆仍在 `<项目>/.biny`。
 *
 * 另外承担历史桌面状态迁移。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "../../../session/store.js";
import type { DesktopProject } from "../../protocol.js";

export class DesktopUserDataStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  /** 未关联任何已打开项目的会话存放处。 */
  globalRoot(): string {
    return path.join(this.root, "global");
  }

  attachmentsRoot(project: DesktopProject): string {
    return path.join(agentDir(project.path), "attachments");
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

  /** 初始化项目本地运行目录及其对应的全局 session 目录。 */
  async ensureProjectData(project: DesktopProject): Promise<string> {
    const targetRoot = path.resolve(project.path);
    await ensureAgentDirs(targetRoot);
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
    await this.ensureProjectData(project);
    const directory = this.attachmentsRoot(project);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
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
