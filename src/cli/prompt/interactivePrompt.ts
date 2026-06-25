/**
 * Raw-mode 交互输入模块。
 *
 * Chat 命令在 TTY 环境下使用这里读取一整行输入，同时支持 slash 菜单、上下选择、Tab 补全、
 * Ctrl+C 结束和终端重绘。非 TTY 场景会退回普通 readline，不走这套 raw-mode 渲染。
 */
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
  // 这个函数接管 raw mode 输入，返回一整行文本；Ctrl+C 返回 undefined。
  return new Promise((resolve) => {
    let buffer = "";
    let menu = createSlashMenuState();
    let renderedLineCount = 0;
    const wasRaw = input.isRaw;

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const cleanup = (): void => {
      // 退出前恢复调用方原有 raw mode 状态，避免影响后续终端输入。
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
    };

    const finish = (line: string | undefined): void => {
      // finish 会清掉菜单重绘区，再把最终输入补打一遍，形成正常命令行记录。
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
      // Ctrl+C 不抛异常，交给上层 chat loop 正常结束当前输入。
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
        // 删除字符后重算菜单查询，选中项回到第一条匹配。
        buffer = buffer.slice(0, -1);
        menu = updateSlashQuery(menu, buffer);
        render();
        return;
      }

      if (key.name === "tab") {
        // Tab 使用 slashMenu 的公共补全逻辑，保持 TTY 和 readline 行为一致。
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
        // 只接收可打印字符；方向键等控制序列通过 key.name 分支处理。
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
  // 查询没变时保留当前状态，避免重复 render 导致选中项跳动。
  if (menu.query === query) return menu;
  const next = updateSlashQuery(menu, query);
  const count = matchingSlashCommands(query, commands).length;
  if (count <= 0) return next;
  return next;
}
