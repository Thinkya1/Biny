import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentConfigStore } from "../../../config/store.js";
import { listModelChoices, type ModelChoice } from "../../../llm/ModelManager.js";
import type { AgentHostEvent, InteractiveRuntimeSnapshot } from "../../../runtime/agentEvents.js";
import { listSessionSummaries, readStoredSessionEvents } from "../../../session/events.js";
import { createSessionFile, deleteSessionFile, duplicateSessionFile, ensureAgentDirs } from "../../../session/store.js";
import { gitInspectionEnvironment } from "../../../tools/git/environment.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../../../workspace/resolvePath.js";
import type {
  DesktopAttachment,
  DesktopProject,
  DesktopSessionDocument,
  DesktopSessionStatus,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceDirectoryEntry,
  DesktopSessionSummary,
  DesktopWorkspaceFilePreview
} from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { DesktopUserDataStore } from "./DesktopUserDataStore.js";

const execFileAsync = promisify(execFile);
const filePreviewLimit = 512 * 1024;

export class DesktopProjectService {
  constructor(
    private readonly state: DesktopStateStore,
    private readonly storage: DesktopUserDataStore,
    private readonly configStore: AgentConfigStore
  ) {}

  async createProject(projectPath: string): Promise<DesktopProject> {
    const resolvedPath = path.resolve(projectPath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) throw new Error("Selected project path is not a directory.");
    const existing = this.state.projects().find((project) => project.path === resolvedPath);
    const now = new Date().toISOString();
    const project = await this.inspectProject({
      id: existing?.id ?? projectId(resolvedPath),
      path: resolvedPath,
      name: existing?.name ?? path.basename(resolvedPath),
      branch: existing?.branch,
      dirty: existing?.dirty ?? false,
      missing: false,
      pinned: existing?.pinned ?? false,
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now
    });
    await this.storage.ensureProjectData(project);
    await this.state.upsertProject(project);
    return project;
  }

  async createEmptyProject(projectPath: string): Promise<DesktopProject> {
    const resolvedPath = path.resolve(projectPath);
    try {
      await fs.mkdir(resolvedPath);
    } catch (error) {
      if (isAlreadyExists(error)) throw new Error("项目文件夹已存在，请选择其他名称。");
      throw error;
    }
    return await this.createProject(resolvedPath);
  }

  async inspectProject(project: DesktopProject): Promise<DesktopProject> {
    const missing = !await directoryExists(project.path);
    if (missing) return { ...project, branch: undefined, dirty: false, missing: true };
    const [branch, status] = await Promise.all([
      gitOutput(project.path, ["branch", "--show-current"]),
      gitOutput(project.path, ["status", "--porcelain", "--ignore-submodules=all"])
    ]);
    return {
      ...project,
      branch: branch?.trim() || undefined,
      dirty: Boolean(status?.trim()),
      missing: false
    };
  }

  async refreshStoredProject(projectIdValue: string): Promise<DesktopProject> {
    const project = this.requireProject(projectIdValue);
    const refreshed = await this.inspectProject(project);
    await this.state.upsertProject({ ...refreshed, lastOpenedAt: new Date().toISOString() });
    return refreshed;
  }

  async refreshAllProjects(): Promise<DesktopProject[]> {
    const activeProjectId = this.state.activeProjectId();
    const projects = await Promise.all(this.state.projects().map(async (project) => await this.inspectProject(project)));
    await Promise.all(projects.map(async (project) => await this.state.upsertProject(project)));
    if (activeProjectId) await this.state.setActiveProject(activeProjectId);
    return projects;
  }

  async listModels(project: DesktopProject): Promise<ModelChoice[]> {
    void project;
    return listModelChoices(await this.configStore.load());
  }

  async listSessions(
    project: DesktopProject,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>
  ): Promise<DesktopSessionSummary[]> {
    if (project.missing) return [];
    const dataRoot = await this.storage.ensureProjectData(project);
    await ensureAgentDirs(dataRoot);
    const summaries = await listSessionSummaries(dataRoot);
    const sessions = summaries.map((summary) => {
      const id = summary.fileName.replace(/\.jsonl$/, "");
      const metadata = this.state.sessionMetadata(project.id, id);
      return {
        id,
        projectId: project.id,
        fileName: summary.fileName,
        title: metadata.title ?? sessionTitle(summary.firstUserMessage),
        firstUserMessage: summary.firstUserMessage,
        lastAssistantMessage: summary.lastAssistantMessage,
        eventCount: summary.eventCount,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        pinned: metadata.pinned ?? false,
        status: sessionStatus(id, summary.lastAssistantMessage, runtime, liveEvents.get(id))
      } satisfies DesktopSessionSummary;
    });

    const runtimeInfo = runtime?.info;
    const runtimeEvents = runtimeInfo ? liveEvents.get(runtimeInfo.sessionId) : undefined;
    if (runtimeInfo && runtimeEvents?.some((event) => event.type === "message.user") && !sessions.some((session) => session.id === runtimeInfo.sessionId)) {
      const metadata = this.state.sessionMetadata(project.id, runtimeInfo.sessionId);
      const now = new Date().toISOString();
      sessions.push({
        id: runtimeInfo.sessionId,
        projectId: project.id,
        fileName: path.basename(runtimeInfo.sessionFile),
        title: metadata.title ?? "新任务",
        firstUserMessage: "",
        lastAssistantMessage: "",
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
        pinned: metadata.pinned ?? false,
        status: sessionStatus(runtimeInfo.sessionId, "", runtime, liveEvents.get(runtimeInfo.sessionId))
      });
    }

    return [...sessions].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }

  async openSession(
    project: DesktopProject,
    sessionId: string,
    runtime: InteractiveRuntimeSnapshot | undefined,
    liveEvents: ReadonlyMap<string, AgentHostEvent[]>
  ): Promise<DesktopSessionDocument> {
    const sessions = await this.listSessions(project, runtime, liveEvents);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const events = await readStoredSessionEvents(await this.storage.ensureProjectData(project), sessionId).then((result) => result.events).catch((error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    });
    return { session, events, liveEvents: [...(liveEvents.get(sessionId) ?? [])] };
  }

  async duplicateSession(project: DesktopProject, sessionId: string): Promise<string> {
    const targetSessionId = createSessionId();
    const dataRoot = await this.storage.ensureProjectData(project);
    await duplicateSessionFile(dataRoot, sessionId, targetSessionId);
    await this.state.copySessionMetadata(project.id, sessionId, targetSessionId);
    return targetSessionId;
  }

  async forkSessionAtUserMessage(project: DesktopProject, sessionId: string, userMessageIndex: number): Promise<string> {
    const dataRoot = await this.storage.ensureProjectData(project);
    const events = await readStoredSessionEvents(dataRoot, sessionId).then((result) => result.events);
    const userEventIndices = events.flatMap((event, index) => event.type === "user_message" ? [index] : []);
    const targetEventIndex = userEventIndices[userMessageIndex];
    if (targetEventIndex === undefined) throw new Error("要编辑的消息已不在当前会话中。");
    const targetSessionId = createSessionId();
    const prefix = events.slice(0, targetEventIndex);
    const content = prefix.length ? `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
    await createSessionFile(dataRoot, targetSessionId, Buffer.from(content, "utf8"));
    await this.state.copySessionMetadata(project.id, sessionId, targetSessionId);
    return targetSessionId;
  }

  async deleteSession(project: DesktopProject, sessionId: string): Promise<void> {
    await deleteSessionFile(await this.storage.ensureProjectData(project), sessionId);
    await this.state.deleteSessionMetadata(project.id, sessionId);
  }

  async saveAttachment(project: DesktopProject, name: string, mimeType: string, bytes: Uint8Array): Promise<DesktopAttachment> {
    const safeName = sanitizeFileName(name);
    await this.storage.ensureProjectData(project);
    const directory = this.storage.attachmentsRoot(project);
    await fs.mkdir(directory, { recursive: true });
    const fileName = `${String(Date.now())}-${randomBytes(3).toString("hex")}-${safeName}`;
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, bytes);
    return {
      name: safeName,
      path: `@attachments/${fileName}`,
      mimeType,
      size: bytes.byteLength
    };
  }

  async listWorkspaceDirectory(project: DesktopProject, relativePath: string): Promise<DesktopWorkspaceDirectory> {
    const directoryPath = this.workspaceDirectory(project, relativePath);
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${relativePath}`);
    const directoryRelativePath = toWorkspaceRelative(project.path, directoryPath);
    const dirEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const entries: DesktopWorkspaceDirectoryEntry[] = dirEntries
      .map((entry) => ({
        name: entry.name,
        path: directoryRelativePath === "." ? entry.name : `${directoryRelativePath.split(path.sep).join("/")}/${entry.name}`,
        kind: entry.isDirectory() ? "directory" : "file"
      } satisfies DesktopWorkspaceDirectoryEntry))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return {
      path: directoryRelativePath.split(path.sep).join("/"),
      entries
    };
  }

  async readWorkspaceFile(project: DesktopProject, relativePath: string): Promise<DesktopWorkspaceFilePreview> {
    const filePath = this.workspaceFile(project, relativePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Path is not a file: ${relativePath}`);
    const previewBytes = Math.min(stat.size, filePreviewLimit);
    const buffer = Buffer.alloc(previewBytes);
    let bytesRead = 0;
    if (previewBytes) {
      const handle = await fs.open(filePath, "r");
      try {
        while (bytesRead < previewBytes) {
          const result = await handle.read(buffer, bytesRead, previewBytes - bytesRead, bytesRead);
          if (!result.bytesRead) break;
          bytesRead += result.bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    const content = buffer.subarray(0, bytesRead);
    const binary = content.includes(0);
    return {
      path: toWorkspaceRelative(project.path, filePath),
      content: binary ? undefined : content.toString("utf8"),
      bytes: stat.size,
      binary,
      truncated: stat.size > bytesRead
    };
  }

  workspaceFile(project: DesktopProject, relativePath: string): string {
    return resolveWorkspacePath(project.path, relativePath, ["node_modules", ".git"]);
  }

  workspaceDirectory(project: DesktopProject, relativePath: string): string {
    return resolveWorkspaceDirectory(project.path, relativePath, ["node_modules", ".git"]);
  }

  requireProject(projectIdValue: string): DesktopProject {
    const project = this.state.project(projectIdValue);
    if (!project) throw new Error(`Unknown project: ${projectIdValue}`);
    return project;
  }

  async dataRoot(project: DesktopProject): Promise<string> {
    return await this.storage.ensureProjectData(project);
  }

  attachmentsRoot(project: DesktopProject): string {
    return this.storage.attachmentsRoot(project);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function projectId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 20);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      ...args
    ], { cwd, env: gitInspectionEnvironment(), timeout: 4_000, maxBuffer: 512 * 1024 })).stdout;
  } catch {
    return undefined;
  }
}

function sessionTitle(firstUserMessage: string): string {
  const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 64) : "新任务";
}

function sessionStatus(
  sessionId: string,
  lastAssistantMessage: string,
  runtime: InteractiveRuntimeSnapshot | undefined,
  events: AgentHostEvent[] | undefined
): DesktopSessionStatus {
  if (runtime?.pendingPermission?.sessionId === sessionId) return "waiting_permission";
  if (runtime?.activeRun?.sessionId === sessionId) return "running";
  const finalEvent = events
    ? [...events].reverse().find((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.aborted")
    : undefined;
  if (finalEvent?.type === "run.failed") return "failed";
  if (finalEvent?.type === "run.completed") return "completed";
  return lastAssistantMessage ? "completed" : "idle";
}

function createSessionId(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function sanitizeFileName(value: string): string {
  const sanitized = path.basename(value).replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g, "-").slice(0, 120);
  return sanitized || "attachment";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
