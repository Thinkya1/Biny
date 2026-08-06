/**
 * Session catalog 与跨 session 分支关系。
 *
 * JSONL 仍然是会话事实和恢复输入；catalog 只保存列表查询需要的轻量控制面，尤其是
 * parent/root/branchPoint。旧会话没有 catalog 文件时按根会话处理，不在读取列表时回写迁移数据。
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectSessionsDir } from "../config/paths.js";
import { listSessionSummaries, type SessionSummary } from "./events.js";
import { ensureAgentDirs } from "./store.js";

const catalogVersion = 1 as const;
const defaultPageSize = 32;
const maxPageSize = 50;
const catalogDirectoryName = ".catalog";

export type SessionBranchPoint =
  | { kind: "event"; index: number }
  | { kind: "user_message"; index: number; messageId?: string };

export interface SessionCatalogRecord {
  version: typeof catalogVersion;
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string;
  branchPoint?: SessionBranchPoint;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionCatalogItem {
  id: string;
  fileName: string;
  summary: SessionSummary;
  rootSessionId: string;
  parentSessionId?: string;
  branchPoint?: SessionBranchPoint;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  metadataRevision?: string;
  hasChildren: boolean;
}

export interface RegisterSessionBranchOptions {
  sessionId: string;
  parentSessionId: string;
  branchPoint: SessionBranchPoint;
}

export interface SessionCatalogQuery {
  limit?: number;
  cursor?: string;
  parentSessionId?: string;
  includeArchived?: boolean;
}

export interface SessionCatalogPage {
  revision: string;
  items: SessionCatalogItem[];
  nextCursor?: string;
  revisionChanged?: boolean;
}

export interface SessionTreeNode {
  session: SessionCatalogItem;
  children: SessionTreeNode[];
}

export interface SessionCatalogMetadataPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
}

export class SessionCatalogConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: string,
    readonly actualRevision: string | undefined
  ) {
    super(`Session catalog revision conflict for ${sessionId}.`);
    this.name = "SessionCatalogConflictError";
  }
}

interface SessionCatalogCursor {
  version: typeof catalogVersion;
  revision: string;
  updatedAt: string;
  sessionId: string;
  parentSessionId?: string;
}

export function sessionCatalogDirectory(workspaceRoot: string): string {
  return path.join(projectSessionsDir(workspaceRoot), catalogDirectoryName);
}

/** 为 fork/clone 写入一条 lineage；父会话的 root 会沿树向上继承。 */
export async function registerSessionBranch(
  workspaceRoot: string,
  options: RegisterSessionBranchOptions
): Promise<SessionCatalogRecord> {
  assertSessionId(options.sessionId);
  assertSessionId(options.parentSessionId);
  assertBranchPoint(options.branchPoint);
  const parent = await readSessionCatalogRecord(workspaceRoot, options.parentSessionId);
  const now = new Date().toISOString();
  return await writeSessionCatalogRecord(workspaceRoot, {
    version: catalogVersion,
    sessionId: options.sessionId,
    rootSessionId: parent?.rootSessionId ?? options.parentSessionId,
    parentSessionId: options.parentSessionId,
    branchPoint: options.branchPoint,
    createdAt: now,
    updatedAt: now
  });
}

export async function writeSessionCatalogRecord(
  workspaceRoot: string,
  record: SessionCatalogRecord,
  options: { expectedRevision?: string } = {}
): Promise<SessionCatalogRecord> {
  assertCatalogRecord(record);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const target = catalogFilePath(directory, record.sessionId);
  const existing = await readCatalogFile(target);
  const actualRevision = existing === undefined ? undefined : sessionCatalogRecordRevision(existing);
  if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
    throw new SessionCatalogConflictError(record.sessionId, options.expectedRevision, actualRevision);
  }
  const next: SessionCatalogRecord = {
    ...existing,
    ...record,
    version: catalogVersion
  };
  await writeAtomically(target, `${JSON.stringify(next)}\n`);
  return next;
}

/** 读取、校验并更新一个会话的常用元数据；expectedRevision 用于挡住过期 Renderer 覆盖新值。 */
export async function updateSessionCatalogMetadata(
  workspaceRoot: string,
  sessionId: string,
  patch: SessionCatalogMetadataPatch,
  expectedRevision?: string
): Promise<SessionCatalogRecord> {
  assertSessionId(sessionId);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const existing = await readCatalogFile(catalogFilePath(directory, sessionId));
  const item = (await listSessionCatalog(workspaceRoot)).find((candidate) => candidate.id === sessionId);
  if (!item && !existing) throw new Error(`Session not found: ${sessionId}`);
  const base = existing ?? {
    version: catalogVersion,
    sessionId,
    rootSessionId: item?.rootSessionId ?? sessionId,
    parentSessionId: item?.parentSessionId,
    branchPoint: item?.branchPoint,
    createdAt: item?.summary.createdAt ?? new Date().toISOString(),
    updatedAt: item?.summary.updatedAt ?? new Date().toISOString()
  } satisfies SessionCatalogRecord;
  return await writeSessionCatalogRecord(workspaceRoot, {
    ...base,
    ...patch,
    labels: patch.labels === undefined ? base.labels : [...patch.labels],
    updatedAt: new Date().toISOString()
  }, { expectedRevision });
}

export async function readSessionCatalogRecord(
  workspaceRoot: string,
  sessionId: string
): Promise<SessionCatalogRecord | undefined> {
  assertSessionId(sessionId);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  return await readCatalogFile(catalogFilePath(directory, sessionId));
}

export async function deleteSessionCatalogRecord(workspaceRoot: string, sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const target = catalogFilePath(directory, sessionId);
  try {
    await assertCatalogFile(target);
    await fs.unlink(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * 把 JSONL 摘要和 catalog 控制面合并成 session 级 read model。
 * catalog 缺失或损坏时只丢 lineage，不影响历史列表和恢复。
 */
export async function listSessionCatalog(workspaceRoot: string): Promise<SessionCatalogItem[]> {
  const summaries = await listSessionSummaries(workspaceRoot);
  if (!summaries.length) return [];
  const directory = await ensureCatalogDirectory(workspaceRoot).catch(() => undefined);
  const items = await Promise.all(summaries.map(async (summary) => {
    const id = summary.fileName.replace(/\.jsonl$/u, "");
    const record = directory === undefined
      ? undefined
      : await readCatalogFile(catalogFilePath(directory, id)).catch(() => undefined);
    return toCatalogItem(summary, record);
  }));
  const parentCounts = new Map<string, number>();
  for (const item of items) {
    if (item.parentSessionId !== undefined) parentCounts.set(item.parentSessionId, (parentCounts.get(item.parentSessionId) ?? 0) + 1);
  }
  return items
    .map((item) => ({ ...item, hasChildren: (parentCounts.get(item.id) ?? 0) > 0 }))
    .sort(compareCatalogItems);
}

export async function getSessionCatalogItem(
  workspaceRoot: string,
  sessionId: string
): Promise<SessionCatalogItem | undefined> {
  assertSessionId(sessionId);
  return (await listSessionCatalog(workspaceRoot)).find((item) => item.id === sessionId);
}

export async function readSessionTree(workspaceRoot: string): Promise<SessionTreeNode[]> {
  return buildSessionTree(await listSessionCatalog(workspaceRoot));
}

/**
 * 分页使用 updatedAt + id 游标，避免 offset 在新消息追加后发生跳项。
 * revision 改变时返回空页并标记 revisionChanged，让调用方从第一页重新拉取。
 */
export async function querySessionCatalog(
  workspaceRoot: string,
  options: SessionCatalogQuery = {}
): Promise<SessionCatalogPage> {
  const limit = normalizePageSize(options.limit);
  const all = await listSessionCatalog(workspaceRoot);
  const filtered = options.parentSessionId === undefined
    ? all
    : all.filter((item) => item.parentSessionId === options.parentSessionId);
  const visible = options.includeArchived === false ? filtered.filter((item) => !item.archived) : filtered;
  const revision = catalogRevision(visible);
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (cursor && (cursor.revision !== revision || cursor.parentSessionId !== options.parentSessionId)) {
    return { revision, items: [], revisionChanged: true };
  }

  const start = cursor === undefined
    ? 0
    : visible.findIndex((item) => isAfterCursor(item, cursor));
  const pageStart = start < 0 ? visible.length : start;
  const items = visible.slice(pageStart, pageStart + limit);
  const last = items.at(-1);
  const lastIndex = last === undefined ? -1 : pageStart + items.length - 1;
  const nextCursor = last !== undefined && lastIndex < visible.length - 1
    ? encodeCursor({
      version: catalogVersion,
      revision,
      updatedAt: last.summary.updatedAt,
      sessionId: last.id,
      parentSessionId: options.parentSessionId
    })
    : undefined;
  return {
    revision,
    items,
    nextCursor,
    revisionChanged: false
  };
}

/** 从 session lineage 构建树；孤儿和异常环路会被提升到根，列表不会丢节点。 */
export function buildSessionTree(items: readonly SessionCatalogItem[]): SessionTreeNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, SessionCatalogItem[]>();
  for (const item of items) {
    if (!item.parentSessionId || item.parentSessionId === item.id || !byId.has(item.parentSessionId)) continue;
    const siblings = children.get(item.parentSessionId) ?? [];
    siblings.push(item);
    children.set(item.parentSessionId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareCatalogItems);

  const roots = items.filter((item) => !item.parentSessionId || item.parentSessionId === item.id || !byId.has(item.parentSessionId));
  const visited = new Set<string>();
  const build = (item: SessionCatalogItem, ancestors: ReadonlySet<string>): SessionTreeNode => {
    visited.add(item.id);
    const nextAncestors = new Set(ancestors).add(item.id);
    const childNodes = (children.get(item.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => build(child, nextAncestors));
    return { session: item, children: childNodes };
  };
  const tree = roots.sort(compareCatalogItems).map((item) => build(item, new Set()));
  // 正常数据不会走到这里；若 catalog 中存在环路，把未遍历节点提升到根，保证列表可见。
  for (const item of [...items].sort(compareCatalogItems)) {
    if (!visited.has(item.id)) tree.push(build(item, new Set()));
  }
  return tree;
}

function toCatalogItem(summary: SessionSummary, record: SessionCatalogRecord | undefined): SessionCatalogItem {
  const id = summary.fileName.replace(/\.jsonl$/u, "");
  return {
    id,
    fileName: summary.fileName,
    summary,
    rootSessionId: record?.rootSessionId ?? id,
    parentSessionId: record?.parentSessionId,
    branchPoint: record?.branchPoint,
    title: record?.title,
    pinned: record?.pinned,
    archived: record?.archived,
    unread: record?.unread,
    labels: record?.labels,
    metadataRevision: record === undefined ? undefined : sessionCatalogRecordRevision(record),
    hasChildren: false
  };
}

function compareCatalogItems(left: SessionCatalogItem, right: SessionCatalogItem): number {
  return sessionTime(right.summary.updatedAt) - sessionTime(left.summary.updatedAt)
    || right.id.localeCompare(left.id);
}

function isAfterCursor(item: SessionCatalogItem, cursor: SessionCatalogCursor): boolean {
  const itemTime = sessionTime(item.summary.updatedAt);
  const cursorTime = sessionTime(cursor.updatedAt);
  return itemTime < cursorTime || itemTime === cursorTime && item.id.localeCompare(cursor.sessionId) < 0;
}

function catalogRevision(items: readonly SessionCatalogItem[]): string {
  const payload = items.map((item) => ({
    id: item.id,
    updatedAt: item.summary.updatedAt,
    eventCount: item.summary.eventCount,
    rootSessionId: item.rootSessionId,
    parentSessionId: item.parentSessionId,
    branchPoint: item.branchPoint,
    title: item.title,
    pinned: item.pinned,
    archived: item.archived,
    unread: item.unread,
    labels: item.labels,
    metadataRevision: item.metadataRevision
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function sessionCatalogRecordRevision(record: SessionCatalogRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function normalizePageSize(limit: number | undefined): number {
  const value = limit ?? defaultPageSize;
  if (!Number.isSafeInteger(value) || value < 1 || value > maxPageSize) {
    throw new RangeError(`Session catalog page size must be between 1 and ${String(maxPageSize)}.`);
  }
  return value;
}

function encodeCursor(cursor: SessionCatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SessionCatalogCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isCursor(parsed)) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw new Error("Invalid session catalog cursor.");
  }
}

function isCursor(value: unknown): value is SessionCatalogCursor {
  if (!isRecord(value)) return false;
  return value.version === catalogVersion
    && typeof value.revision === "string"
    && typeof value.updatedAt === "string"
    && typeof value.sessionId === "string"
    && (value.parentSessionId === undefined || typeof value.parentSessionId === "string");
}

async function ensureCatalogDirectory(workspaceRoot: string): Promise<string> {
  await ensureAgentDirs(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const sessionsDirectory = path.resolve(projectSessionsDir(canonicalWorkspace));
  if (await fs.realpath(sessionsDirectory) !== sessionsDirectory) {
    throw new Error("Project session storage resolves outside the global session directory.");
  }
  const directory = path.join(sessionsDirectory, catalogDirectoryName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
    throw new Error("Session catalog directory must be a real directory.");
  }
  await fs.chmod(directory, 0o700);
  return directory;
}

function catalogFilePath(directory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(directory, `${sessionId}.json`);
}

async function readCatalogFile(filePath: string): Promise<SessionCatalogRecord | undefined> {
  try {
    await assertCatalogFile(filePath);
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isCatalogRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function assertCatalogFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Session catalog record must be a single-link regular file: ${path.basename(filePath)}`);
  }
  if (await fs.realpath(path.dirname(filePath)) !== path.dirname(filePath)) {
    throw new Error("Session catalog directory changed during access.");
  }
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertCatalogRecord(record: SessionCatalogRecord): void {
  if (record.version !== catalogVersion) throw new Error("Unsupported session catalog version.");
  assertSessionId(record.sessionId);
  assertSessionId(record.rootSessionId);
  if (record.parentSessionId !== undefined) assertSessionId(record.parentSessionId);
  if (record.branchPoint !== undefined) assertBranchPoint(record.branchPoint);
  assertCatalogMetadata(record);
  if (!record.createdAt || !record.updatedAt) throw new Error("Session catalog timestamps are required.");
}

function isCatalogRecord(value: unknown): value is SessionCatalogRecord {
  if (!isRecord(value) || value.version !== catalogVersion) return false;
  if (typeof value.sessionId !== "string" || typeof value.rootSessionId !== "string") return false;
  if (value.parentSessionId !== undefined && typeof value.parentSessionId !== "string") return false;
  if (value.branchPoint !== undefined && !isBranchPoint(value.branchPoint)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") return false;
  if (value.archived !== undefined && typeof value.archived !== "boolean") return false;
  if (value.unread !== undefined && typeof value.unread !== "boolean") return false;
  if (value.labels !== undefined && (!Array.isArray(value.labels) || !value.labels.every((label) => typeof label === "string"))) return false;
  return typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function assertCatalogMetadata(record: SessionCatalogRecord): void {
  if (record.title !== undefined && (!record.title.trim() || record.title.length > 120)) throw new Error("Invalid session catalog title.");
  if (record.labels !== undefined && record.labels.some((label) => !label.trim() || label.length > 64)) throw new Error("Invalid session catalog labels.");
}

function assertBranchPoint(value: SessionBranchPoint): void {
  if (!isBranchPoint(value)) throw new Error("Invalid session branch point.");
}

function isBranchPoint(value: unknown): value is SessionBranchPoint {
  if (!isRecord(value) || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 0) return false;
  if (value.kind === "event") return true;
  return value.kind === "user_message" && (value.messageId === undefined || typeof value.messageId === "string");
}

function assertSessionId(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid session id: ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
