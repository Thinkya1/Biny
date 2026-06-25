/**
 * Slash 菜单状态模块。
 *
 * CLI chat 和 TUI 输入框共用这套函数来过滤命令、计算可见菜单行、移动选中项和补全公共前缀。
 * 它只处理状态和字符串，不直接渲染终端 UI。
 */
export interface SlashCommand {
  // name 必须包含前导 /，用于过滤、补全和最终写回输入框。
  name: string;
  description: string;
  category: string;
  requiresArgs?: boolean;
}

export type SlashMenuRow =
  | { type: "header"; label: string }
  | { type: "command"; command: SlashCommand; index: number };
type SlashMenuCommandRow = Extract<SlashMenuRow, { type: "command" }>;

export interface SlashMenuState {
  query: string;
  selected: number;
  // offset 是渲染行偏移，不是命令数组偏移；因为菜单里还会插入 category header。
  offset: number;
  visibleRows: number;
}

export function createSlashMenuState(visibleRows = 8): SlashMenuState {
  // visibleRows 限制终端里菜单高度，超出部分通过 offset 滚动。
  return {
    query: "",
    selected: 0,
    offset: 0,
    visibleRows
  };
}

export function updateSlashQuery(state: SlashMenuState, query: string): SlashMenuState {
  // 新查询从第一条匹配开始，避免沿用旧查询下的越界选中项。
  return clampState({ ...state, query, selected: 0, offset: 0 }, 0);
}

export function moveSlashSelection(state: SlashMenuState, commands: SlashCommand[], direction: -1 | 1): SlashMenuState {
  // 上下移动采用循环选择，到首尾后继续跳到另一端。
  const matches = matchingSlashCommands(state.query, commands);
  if (!matches.length) return { ...state, selected: 0, offset: 0 };
  const selected = (state.selected + direction + matches.length) % matches.length;
  return clampState({ ...state, selected }, commands);
}

export function matchingSlashCommands(query: string, commands: SlashCommand[]): SlashCommand[] {
  // 只用当前 slash token 匹配命令名，参数部分不参与过滤。
  const token = slashToken(query);
  return commands.filter((command) => command.name.startsWith(token));
}

export function visibleSlashRows(state: SlashMenuState, commands: SlashCommand[]): SlashMenuRow[] {
  // 可见行包含分类 header，所以不能直接按命令数组 slice。
  const matches = matchingSlashCommands(state.query, commands);
  const rows = buildRows(matches);
  return rows.slice(state.offset, state.offset + state.visibleRows);
}

export function selectedSlashCommand(state: SlashMenuState, commands: SlashCommand[]): SlashCommand | undefined {
  // selected 是匹配命令数组的下标，不包含 header 行。
  return matchingSlashCommands(state.query, commands)[state.selected];
}

export function shouldShowSlashPalette(buffer: string): boolean {
  // 输入参数后隐藏菜单，避免 /plan task 仍被当作命令名过滤。
  return buffer.startsWith("/") && !/\s/.test(buffer);
}

export function completeSlashCommand(buffer: string, commands: SlashCommand[]): string {
  // 单一匹配直接补全并追加空格；多匹配只补到公共前缀。
  if (!buffer.startsWith("/")) return buffer;
  const [token = buffer, ...rest] = buffer.split(/\s+/);
  const matches = commands.map((command) => command.name).filter((command) => command.startsWith(token));
  if (matches.length === 1) {
    return rest.length ? `${matches[0]} ${rest.join(" ")}` : `${matches[0]} `;
  }
  const prefix = commonPrefix(matches);
  return prefix.length > token.length ? `${prefix}${buffer.slice(token.length)}` : buffer;
}

export function shouldSelectSlashCommand(buffer: string, selectedCommand: string, commands: SlashCommand[]): boolean {
  // 已经完整输入且没有歧义时，Enter 应执行命令而不是重复补全。
  const [token = buffer, ...rest] = buffer.trim().split(/\s+/);
  if (rest.length) return false;
  return token !== selectedCommand || matchingSlashCommands(buffer, commands).length > 1;
}

function slashToken(query: string): string {
  // slash token 是第一个空白前的部分，例如 /resume abc 只取 /resume。
  return query.split(/\s+/)[0] ?? query;
}

function clampState(state: SlashMenuState, commands: SlashCommand[] | 0): SlashMenuState {
  // clamp 同时修正 selected 和 offset，确保渲染层不用处理越界状态。
  if (commands === 0) return { ...state, selected: 0, offset: 0 };
  const matches = matchingSlashCommands(state.query, commands);
  if (!matches.length) return { ...state, selected: 0, offset: 0 };
  const selected = Math.min(Math.max(state.selected, 0), matches.length - 1);
  const rows = buildRows(matches);
  const selectedRow = rows.findIndex((row) => row.type === "command" && row.index === selected);
  // 保证当前选中的命令始终落在可见区域里。
  const maxOffset = Math.max(0, rows.length - state.visibleRows);
  let offset = Math.min(Math.max(state.offset, 0), maxOffset);

  if (selectedRow !== -1 && selectedRow < offset) {
    offset = selectedRow;
  } else if (selectedRow !== -1 && selectedRow >= offset + state.visibleRows) {
    offset = selectedRow - state.visibleRows + 1;
  }

  return { ...state, selected, offset };
}

function buildRows(commands: SlashCommand[]): SlashMenuRow[] {
  // 将命令按已有顺序插入分类 header，header 本身不可选中。
  const commandRows = commands.map<SlashMenuCommandRow>((command, index) => ({ type: "command", command, index }));
  const rows: SlashMenuRow[] = [];
  let category = "";

  for (const row of commandRows) {
    if (row.command.category !== category) {
      category = row.command.category;
      rows.push({ type: "header", label: category });
    }
    rows.push(row);
  }

  return rows;
}

function commonPrefix(values: string[]): string {
  // 多个匹配项按最长公共前缀补全，类似 shell completion。
  if (!values.length) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}
