/**
 * 当前工作区的真实上下文摘要。
 *
 * 只展示 DesktopProject 已确认的数据；没有文件数、Repo Map 等服务端数据时不制造占位能力。
 */
import { Button } from "@astryxdesign/core/Button";
import { Popover } from "@astryxdesign/core/Popover";
import type { DesktopProject } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

export function WorkspaceContextBar({
  project,
  onBrowseFiles
}: {
  project: DesktopProject;
  onBrowseFiles(): void;
}): React.JSX.Element {
  const repositoryStatus = project.missing
    ? "路径不可用"
    : project.dirty
      ? "有未提交更改"
      : "工作区干净";
  return (
    <Popover
      alignment="start"
      content={(
        <section className="workspace-context-popover">
          <header>
            <Icon name="folder" size={16} />
            <span><strong>Project Context</strong><small>{project.path}</small></span>
          </header>
          <dl>
            <div><dt>Workspace</dt><dd>{project.name}</dd></div>
            <div><dt>Source</dt><dd>Local</dd></div>
            <div><dt>Branch</dt><dd>{project.branch ?? "未检测到"}</dd></div>
            <div><dt>Changes</dt><dd>{repositoryStatus}</dd></div>
          </dl>
          <Button icon={<Icon name="folder-panel" size={14} />} label="浏览工作区文件" onClick={onBrowseFiles} size="sm" variant="secondary" width="100%" />
        </section>
      )}
      label="项目上下文"
      placement="below"
      width={320}
    >
      {(triggerProps) => (
        <button className="workspace-context-trigger" type="button" {...triggerProps}>
          <Icon name="folder" size={12} />
          <span>{project.name}</span>
          <small>Local</small>
          {project.branch ? <small>{project.branch}</small> : null}
          {project.dirty ? <span aria-label="有未提交更改" className="workspace-context-dirty" title="有未提交更改" /> : null}
          <Icon name="chevron" size={11} />
        </button>
      )}
    </Popover>
  );
}
