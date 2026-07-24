import type { ProjectContext } from "../../project/ProjectContext.js";

export interface LoadedInstruction {
  path: string;
  content: string;
  bytes: number;
}

export interface ProjectSnapshot {
  context: ProjectContext;
  refreshedAt: string;
  revision: number;
}

export type RepoMapRole = "entry" | "test" | "source" | "config" | "other";

export interface RepoMapEntry {
  path: string;
  role: RepoMapRole;
  symbols: string[];
  imports: string[];
  exports: string[];
}

export interface RecentWorkspaceActivity {
  paths: string[];
  summaries: string[];
}

export interface WorkspaceTurnData {
  instructions: LoadedInstruction[];
  snapshot: ProjectSnapshot;
  explicitPaths: string[];
  recentActivity: RecentWorkspaceActivity;
  repoMapCandidates: RepoMapEntry[];
}

export interface ContextBudgetStatus {
  maxTokens: number;
  usedTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelAlias?: string;
  omitted: string[];
  autoCompacted: boolean;
  source?: "estimated" | "provider";
  measuredAt?: string;
}

export interface CompactionStatus {
  summaryPresent: boolean;
  compactedMessages: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  compactedMessageCount: number;
  summary?: string;
}

export interface ContextStatus {
  loadedInstructions: string[];
  instructionBytes: number;
  instructionCapBytes: number;
  snapshotRefreshedAt?: string;
  snapshotDirty: boolean;
  repoMapRefreshedAt?: string;
  repoMapDirty: boolean;
  repoMapEntries: number;
  activePaths: string[];
  recentActivity: RecentWorkspaceActivity;
  compaction: CompactionStatus;
  budget: ContextBudgetStatus;
  memoryEnabled: boolean;
  memoryTopics: string[];
}

export interface MemoryEntry {
  topic: string;
  title: string;
  summary: string;
  decisions: string[];
  paths: string[];
  keywords: string[];
}

export interface MemoryMatch {
  topic: string;
  path: string;
  excerpt: string;
  score: number;
}
