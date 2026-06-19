import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import {
  completeSlashCommand,
  createSlashMenuState,
  matchingSlashCommands,
  moveSlashSelection,
  selectedSlashCommand,
  shouldSelectSlashCommand,
  shouldShowSlashPalette,
  updateSlashQuery,
  visibleSlashRows,
  type SlashCommand,
  type SlashMenuState
} from "./slashMenu.js";

export function readInteractiveLine(prompt: string, commands: SlashCommand[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let menu = createSlashMenuState();
    let renderedLineCount = 0;
    const wasRaw = input.isRaw;

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
    };

    const finish = (line: string | undefined): void => {
      clearRenderedBlock();
      if (line !== undefined) {
        output.write(`${prompt}${line}`);
      }
      cleanup();
      output.write("\n");
      resolve(line);
    };

    const clearRenderedBlock = (): void => {
      // slash 菜单每次重绘前都回到上一次 prompt 起点并清空旧内容，
      // 否则上下键移动时会在终端里叠出多份菜单。
      if (renderedLineCount > 1) {
        moveCursor(output, 0, -renderedLineCount);
      }
      cursorTo(output, 0);
      clearScreenDown(output);
      renderedLineCount = 0;
    };

    const render = (): void => {
      clearRenderedBlock();
      output.write(`${prompt}${buffer}`);
      let nextRenderedLineCount = 1;
      if (shouldShowSlashPalette(buffer)) {
        // 只有还在输入命令名时展示菜单；选中需要参数的命令后会补空格并隐藏菜单。
        menu = updateMenuQuery(menu, buffer, commands);
        const rows = visibleSlashRows(menu, commands);
        output.write("\n");
        if (!rows.length) {
          output.write("  no matching commands\n");
          nextRenderedLineCount += 1;
        }
        for (const row of rows) {
          if (row.type === "header") {
            output.write(`  ${row.label}\n`);
            nextRenderedLineCount += 1;
            continue;
          }

          const selected = row.index === menu.selected;
          const marker = selected ? ">" : " ";
          const line = `${marker} ${row.command.name.padEnd(14)} ${row.command.description}`;
          output.write(selected ? `\x1b[7m${line}\x1b[0m\n` : `${line}\n`);
          nextRenderedLineCount += 1;
        }
      }
      renderedLineCount = nextRenderedLineCount;
    };

    function onKeypress(sequence: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void {
      if (key.ctrl && key.name === "c") {
        finish(undefined);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        if (shouldShowSlashPalette(buffer)) {
          const selected = selectedSlashCommand(menu, commands);
          if (selected && shouldSelectSlashCommand(buffer, selected.name, commands)) {
            // /plan 和 /resume 需要继续输入参数，所以 Enter 先把命令补到输入框。
            buffer = selected.requiresArgs ? `${selected.name} ` : selected.name;
            if (selected.requiresArgs) {
              render();
              return;
            }
          }
        }
        finish(buffer);
        return;
      }

      if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
        menu = updateSlashQuery(menu, buffer);
        render();
        return;
      }

      if (key.name === "tab") {
        buffer = completeSlashCommand(buffer, commands);
        menu = updateSlashQuery(menu, buffer);
        render();
        return;
      }

      if (shouldShowSlashPalette(buffer) && (key.name === "up" || key.name === "down")) {
        const matches = matchingSlashCommands(buffer, commands);
        if (matches.length) {
          menu = moveSlashSelection(menu, commands, key.name === "up" ? -1 : 1);
          render();
        }
        return;
      }

      if (sequence && !key.ctrl && sequence >= " ") {
        buffer += sequence;
        menu = updateSlashQuery(menu, buffer);
        render();
      }
    }

    input.on("keypress", onKeypress);
    render();
  });
}

function updateMenuQuery(menu: SlashMenuState, query: string, commands: SlashCommand[]): SlashMenuState {
  if (menu.query === query) return menu;
  const next = updateSlashQuery(menu, query);
  const count = matchingSlashCommands(query, commands).length;
  if (count <= 0) return next;
  return next;
}
