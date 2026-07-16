import { promises as fs } from "node:fs";
import path from "node:path";
import { clampStoredFilePanelWidth, DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import type { DesktopProject } from "../../protocol.js";

interface DesktopSessionMetadata {
  title?: string;
  pinned?: boolean;
}

export interface DesktopWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface PersistedDesktopState {
  version: 1;
  projects: DesktopProject[];
  activeProjectId?: string;
  selectedSessionIds: Record<string, string>;
  sessionMetadata: Record<string, DesktopSessionMetadata>;
  sidebarWidth: number;
  filePanelWidth: number;
  windowBounds?: DesktopWindowBounds;
}

const defaultState: PersistedDesktopState = {
  version: 1,
  projects: [],
  activeProjectId: undefined,
  selectedSessionIds: {},
  sessionMetadata: {},
  sidebarWidth: 216,
  filePanelWidth: DEFAULT_FILE_PANEL_WIDTH,
  windowBounds: undefined
};

export class DesktopStateStore {
  private state: PersistedDesktopState = structuredClone(defaultState);
  private writeTail = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<PersistedDesktopState>;
      this.state = {
        version: 1,
        projects: Array.isArray(raw.projects) ? raw.projects.map((project) => ({ ...project, pinned: project.pinned === true })) : [],
        activeProjectId: typeof raw.activeProjectId === "string" ? raw.activeProjectId : undefined,
        selectedSessionIds: isRecord(raw.selectedSessionIds) ? stringRecord(raw.selectedSessionIds) : {},
        sessionMetadata: isRecord(raw.sessionMetadata) ? metadataRecord(raw.sessionMetadata) : {},
        sidebarWidth: typeof raw.sidebarWidth === "number" ? clampSidebarWidth(raw.sidebarWidth) : 216,
        filePanelWidth: typeof raw.filePanelWidth === "number" ? clampStoredFilePanelWidth(raw.filePanelWidth) : DEFAULT_FILE_PANEL_WIDTH,
        windowBounds: validWindowBounds(raw.windowBounds) ? raw.windowBounds : undefined
      };
    } catch (error) {
      if (isNotFound(error)) return;
      const corruptPath = `${this.filePath}.corrupt-${String(Date.now())}`;
      await fs.rename(this.filePath, corruptPath).catch(() => undefined);
      this.state = structuredClone(defaultState);
    }
  }

  projects(): DesktopProject[] {
    return this.state.projects.map((project) => ({ ...project }));
  }

  project(projectId: string): DesktopProject | undefined {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    return project ? { ...project } : undefined;
  }

  async upsertProject(project: DesktopProject): Promise<void> {
    const index = this.state.projects.findIndex((candidate) => candidate.id === project.id);
    if (index === -1) this.state.projects.push({ ...project });
    else this.state.projects[index] = { ...project };
    this.state.activeProjectId = project.id;
    await this.save();
  }

  async removeProject(projectId: string): Promise<void> {
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId);
    delete this.state.selectedSessionIds[projectId];
    for (const key of Object.keys(this.state.sessionMetadata)) {
      if (key.startsWith(`${projectId}:`)) delete this.state.sessionMetadata[key];
    }
    if (this.state.activeProjectId === projectId) this.state.activeProjectId = this.state.projects.at(0)?.id;
    await this.save();
  }

  activeProjectId(): string | undefined {
    return this.state.activeProjectId;
  }

  async setActiveProject(projectId: string | undefined): Promise<void> {
    this.state.activeProjectId = projectId;
    await this.save();
  }

  async setProjectPinned(projectId: string, pinned: boolean): Promise<void> {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.pinned = pinned;
    await this.save();
  }

  async setProjectName(projectId: string, name: string): Promise<void> {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.name = name;
    await this.save();
  }

  selectedSessionId(projectId: string): string | undefined {
    return this.state.selectedSessionIds[projectId];
  }

  async setSelectedSession(projectId: string, sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) delete this.state.selectedSessionIds[projectId];
    else this.state.selectedSessionIds[projectId] = sessionId;
    await this.save();
  }

  sessionMetadata(projectId: string, sessionId: string): DesktopSessionMetadata {
    return { ...this.state.sessionMetadata[metadataKey(projectId, sessionId)] };
  }

  async setSessionTitle(projectId: string, sessionId: string, title: string): Promise<void> {
    const key = metadataKey(projectId, sessionId);
    this.state.sessionMetadata[key] = { ...this.state.sessionMetadata[key], title };
    await this.save();
  }

  async setSessionPinned(projectId: string, sessionId: string, pinned: boolean): Promise<void> {
    const key = metadataKey(projectId, sessionId);
    this.state.sessionMetadata[key] = { ...this.state.sessionMetadata[key], pinned };
    await this.save();
  }

  async copySessionMetadata(projectId: string, sourceSessionId: string, targetSessionId: string): Promise<void> {
    const source = this.sessionMetadata(projectId, sourceSessionId);
    this.state.sessionMetadata[metadataKey(projectId, targetSessionId)] = {
      title: source.title ? `${source.title} 副本` : undefined,
      pinned: false
    };
    await this.save();
  }

  async deleteSessionMetadata(projectId: string, sessionId: string): Promise<void> {
    delete this.state.sessionMetadata[metadataKey(projectId, sessionId)];
    if (this.state.selectedSessionIds[projectId] === sessionId) delete this.state.selectedSessionIds[projectId];
    await this.save();
  }

  sidebarWidth(): number {
    return this.state.sidebarWidth;
  }

  async setSidebarWidth(width: number): Promise<void> {
    this.state.sidebarWidth = clampSidebarWidth(width);
    await this.save();
  }

  filePanelWidth(): number {
    return this.state.filePanelWidth;
  }

  async setFilePanelWidth(width: number): Promise<void> {
    this.state.filePanelWidth = clampStoredFilePanelWidth(width);
    await this.save();
  }

  windowBounds(): DesktopWindowBounds | undefined {
    return this.state.windowBounds ? { ...this.state.windowBounds } : undefined;
  }

  async setWindowBounds(bounds: DesktopWindowBounds): Promise<void> {
    this.state.windowBounds = { ...bounds };
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, `${snapshot}\n`, "utf8");
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeTail;
  }
}

function metadataKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

function clampSidebarWidth(width: number): number {
  return Math.min(320, Math.max(190, Math.round(width)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function metadataRecord(value: Record<string, unknown>): Record<string, DesktopSessionMetadata> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, metadata]) => {
    if (!isRecord(metadata)) return [];
    return [[key, {
      title: typeof metadata.title === "string" ? metadata.title : undefined,
      pinned: typeof metadata.pinned === "boolean" ? metadata.pinned : undefined
    }]];
  }));
}

function validWindowBounds(value: unknown): value is DesktopWindowBounds {
  if (!isRecord(value)) return false;
  return typeof value.width === "number" && typeof value.height === "number";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
