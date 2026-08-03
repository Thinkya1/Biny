/** Cmd+K 项目与任务搜索。 */
import { useMemo } from "react";
import { CommandPalette, CommandPaletteInput } from "@astryxdesign/core/CommandPalette";
import { createStaticSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import type { DesktopProject, DesktopSessionSummary } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

interface SearchOverlayProps {
  open: boolean;
  projects: DesktopProject[];
  sessions: DesktopSessionSummary[];
  onClose(): void;
  onProject(projectId: string): void;
  onSession(projectId: string, sessionId: string): void;
}

type DesktopSearchItem = SearchableItem<{
  detail: string;
  group: string;
  keywords: string[];
  kind: "project" | "session";
  projectId: string;
  targetId: string;
}>;

export function SearchOverlay({
  open,
  projects,
  sessions,
  onClose,
  onProject,
  onSession
}: SearchOverlayProps): React.JSX.Element | null {
  const items = useMemo<DesktopSearchItem[]>(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return [
      ...projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      auxiliaryData: {
        detail: project.path,
        group: "项目",
        keywords: [project.path],
        kind: "project" as const,
        projectId: project.id,
        targetId: project.id
      }
      })),
      ...sessions.map((session) => {
        const project = projectById.get(session.projectId);
        return {
          id: `session:${session.projectId}:${session.id}`,
      label: session.title,
      auxiliaryData: {
            detail: `${project?.name ?? "未知项目"} · ${session.firstUserMessage || "空会话"}`,
        group: "任务",
            keywords: [project?.name ?? "", project?.path ?? "", session.firstUserMessage],
        kind: "session" as const,
            projectId: session.projectId,
        targetId: session.id
      }
        };
      })
    ];
  }, [projects, sessions]);
  const searchSource = useMemo(() => createStaticSource(items, {
    keywords: (item) => item.auxiliaryData?.keywords ?? []
  }), [items]);

  return (
    <CommandPalette
      emptyBootstrapText="还没有可搜索的项目或任务"
      emptySearchText="没有匹配结果"
      input={<CommandPaletteInput endContent={<kbd>⌘K</kbd>} label="搜索项目或任务" placeholder="搜索项目或任务…" />}
      isOpen={open}
      label="快速打开"
      maxHeight="min(560px, calc(100vh - 96px))"
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      onValueChange={(value) => {
        const selected = items.find((item) => item.id === value)?.auxiliaryData;
        if (!selected) return;
        if (selected.kind === "project") onProject(selected.targetId);
        else onSession(selected.projectId, selected.targetId);
        onClose();
      }}
      renderItem={(item) => (
        <div className="command-palette-row">
          <Icon name={item.auxiliaryData?.kind === "project" ? "folder" : "edit"} size={14} />
          <span className="command-palette-row-copy">
            <strong>{item.label}</strong>
            <small>{item.auxiliaryData?.detail}</small>
          </span>
          <span className="command-palette-row-path">打开</span>
        </div>
      )}
      searchSource={searchSource}
      width="min(680px, calc(100vw - 48px))"
    />
  );
}
