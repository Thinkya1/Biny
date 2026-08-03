/** Composer 的权限与思考级别弹出菜单。 */
import type { ThinkingSelection } from "../../../../../llm/ModelManager.js";
import type { PermissionMode } from "../../../../../permission/PermissionManager.js";
import { useClosingPresence } from "../../useClosingPresence.js";
import { Icon } from "../Icon.js";
import { permissionOptions, thinkingDescription, thinkingLabel } from "./composerLabels.js";

export function PermissionMenu({ mode, open, onChange }: {
  mode: PermissionMode;
  open: boolean;
  onChange(mode: PermissionMode): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <div className={`t-dropdown composer-popover permission-menu ${presenceClass(presence.phase)}`} data-origin="bottom-left" role="menu">
      <div className="popover-heading">权限模式</div>
      {permissionOptions.map((option) => (
        <button className={`menu-option${option.mode === mode ? " is-selected" : ""}`} key={option.mode} onClick={() => onChange(option.mode)} role="menuitemradio" type="button">
          <span className="menu-check">{option.mode === mode ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
          {option.risk ? <span className="risk-label">{option.risk}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function ThinkingMenu({
  allowOff,
  current,
  efforts,
  open,
  onChange
}: {
  allowOff: boolean;
  current: ThinkingSelection;
  efforts: ThinkingSelection[];
  open: boolean;
  onChange(thinking: ThinkingSelection): void;
}): React.JSX.Element | null {
  const presence = useClosingPresence(open);
  if (!presence.present) return null;
  return (
    <div className={`t-dropdown composer-popover thinking-level-menu ${presenceClass(presence.phase)}`} data-origin="bottom-left" role="menu">
      <div className="popover-heading">思考级别</div>
      {([...(allowOff ? ["off" as const] : []), ...efforts] as ThinkingSelection[]).map((effort) => (
        <button className={`menu-option${effort === current ? " is-selected" : ""}`} key={effort} onClick={() => onChange(effort)} role="menuitemradio" type="button">
          <span className="menu-check">{effort === current ? <Icon name="check" size={14} /> : null}</span>
          <span className="menu-option-copy"><strong>{thinkingLabel(effort)}</strong><small>{thinkingDescription(effort)}</small></span>
        </button>
      ))}
    </div>
  );
}

function presenceClass(phase: "closed" | "opening" | "open" | "closing"): string {
  if (phase === "open") return "is-open";
  if (phase === "closing") return "is-closing";
  return "";
}
