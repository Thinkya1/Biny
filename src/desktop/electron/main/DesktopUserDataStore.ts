/**
 * 桌面端专属数据目录（Electron userData 下）：配置、凭据、界面状态，以及不属于任何项目的会话。
 *
 * 属于项目的 session 放在全局项目会话目录；附件、run 和记忆仍在 `<项目>/.biny`。
 *
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
