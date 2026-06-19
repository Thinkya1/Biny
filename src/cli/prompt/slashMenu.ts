export interface SlashCommand {
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
  return {
    query: "",
    selected: 0,
    offset: 0,
    visibleRows
  };
}

export function updateSlashQuery(state: SlashMenuState, query: string): SlashMenuState {
  return clampState({ ...state, query, selected: 0, offset: 0 }, 0);
}

export function moveSlashSelection(state: SlashMenuState, commands: SlashCommand[], direction: -1 | 1): SlashMenuState {
  const matches = matchingSlashCommands(state.query, commands);
  if (!matches.length) return { ...state, selected: 0, offset: 0 };
  const selected = (state.selected + direction + matches.length) % matches.length;
  return clampState({ ...state, selected }, commands);
}

export function matchingSlashCommands(query: string, commands: SlashCommand[]): SlashCommand[] {
  const token = slashToken(query);
  return commands.filter((command) => command.name.startsWith(token));
}

export function visibleSlashRows(state: SlashMenuState, commands: SlashCommand[]): SlashMenuRow[] {
  const matches = matchingSlashCommands(state.query, commands);
  const rows = buildRows(matches);
  return rows.slice(state.offset, state.offset + state.visibleRows);
}

export function selectedSlashCommand(state: SlashMenuState, commands: SlashCommand[]): SlashCommand | undefined {
  return matchingSlashCommands(state.query, commands)[state.selected];
}

export function shouldShowSlashPalette(buffer: string): boolean {
  return buffer.startsWith("/") && !/\s/.test(buffer);
}

export function completeSlashCommand(buffer: string, commands: SlashCommand[]): string {
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
  const [token = buffer, ...rest] = buffer.trim().split(/\s+/);
  if (rest.length) return false;
  return token !== selectedCommand || matchingSlashCommands(buffer, commands).length > 1;
}

function slashToken(query: string): string {
  return query.split(/\s+/)[0] ?? query;
}

function clampState(state: SlashMenuState, commands: SlashCommand[] | 0): SlashMenuState {
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
  if (!values.length) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}
