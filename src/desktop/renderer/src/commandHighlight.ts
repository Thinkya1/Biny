/**
 * 命令行分词：把 shell 命令切成带语义的片段，渲染时按片段着色，让命令读起来有主次
 * （程序名最亮，参数次一档，重定向和管道退到点缀色，引号里的内容单独一色）。
 *
 * 不做完整的 shell 语法解析：认不出来的写法一律退回 `plain`，绝不丢字符——所有片段按顺序
 * 拼回去必须等于原命令，否则展示出来的命令和实际执行的命令就不是一回事了。
 */

export type CommandTokenKind =
  | "program"
  | "subcommand"
  | "flag"
  | "string"
  | "operator"
  | "variable"
  | "comment"
  | "path"
  | "plain";

export interface CommandToken {
  kind: CommandTokenKind;
  text: string;
}

/**
 * 这些命令的第二个裸词是子命令（git commit、pnpm run），值得比普通参数亮一档；
 * 其余命令的第二个词多半只是参数（echo hello），强调反而误导，所以只认白名单。
 */
const SUBCOMMAND_DRIVERS = new Set([
  "apt", "apt-get", "brew", "cargo", "docker", "gh", "git", "go", "kubectl",
  "npm", "npx", "pip", "pip3", "pnpm", "systemctl", "tsx", "yarn"
]);

const OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "{", "}", "="]);
// 这些操作符会开启新的命令段，之后的第一个裸词重新算作程序名。
const SEGMENT_BREAK_CHARS = new Set(["|", "&", ";", "(", "{"]);

export function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  const push = (kind: CommandTokenKind, text: string): void => {
    if (text) tokens.push({ kind, text });
  };

  let index = 0;
  let wordIndex = 0; // 当前命令段里已出现的裸词个数
  let program = "";
  let atWordStart = true; // 只有词首的裸片段参与程序名/子命令判定

  while (index < command.length) {
    const char = command[index] ?? "";

    if (isSpace(char)) {
      const spaces = takeWhile(command, index, isSpace);
      if (spaces.includes("\n")) {
        wordIndex = 0;
        program = "";
      }
      push("plain", spaces);
      index += spaces.length;
      atWordStart = true;
      continue;
    }

    // `#` 只在词首才是注释，`foo#bar` 里的 `#` 仍属于参数本身。
    if (char === "#" && atWordStart) {
      const lineBreak = command.indexOf("\n", index);
      const comment = lineBreak === -1 ? command.slice(index) : command.slice(index, lineBreak);
      push("comment", comment);
      index += comment.length;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      const quoted = readQuoted(command, index);
      push("string", quoted);
      index += quoted.length;
      atWordStart = false;
      continue;
    }

    if (char === "$") {
      if (command[index + 1] === "(") {
        push("operator", "$(");
        index += 2;
        wordIndex = 0;
        program = "";
        atWordStart = true;
        continue;
      }
      const variable = readVariable(command, index);
      push("variable", variable);
      index += variable.length;
      atWordStart = false;
      continue;
    }

    if (OPERATOR_CHARS.has(char)) {
      const operator = takeWhile(command, index, (candidate) => OPERATOR_CHARS.has(candidate));
      push("operator", operator);
      index += operator.length;
      // 重定向里的 `&`（`2>&1`、`>&2`）不开启新命令段，只有独立的 `&`、`&&`、`|`、`;` 才算。
      const breaksSegment = !operator.startsWith(">") && !operator.startsWith("<")
        && [...operator].some((candidate) => SEGMENT_BREAK_CHARS.has(candidate));
      if (breaksSegment) {
        wordIndex = 0;
        program = "";
        atWordStart = true;
      } else {
        // `=`、`>` 后面接的是赋值右值或重定向目标，不是新命令的程序名。
        atWordStart = false;
      }
      continue;
    }

    const word = takeWhile(command, index, isWordChar);
    index += word.length;
    if (!atWordStart) {
      push(looksLikePath(word) ? "path" : "plain", word);
      continue;
    }
    // `FOO=bar cmd`：前缀环境变量不占用词序，后面的 cmd 仍是程序名。
    if (wordIndex === 0 && command[index] === "=" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
      push("variable", word);
      atWordStart = false;
      continue;
    }
    push(classifyWord(word, wordIndex, program), word);
    if (wordIndex === 0) program = basename(word);
    wordIndex += 1;
    atWordStart = false;
  }

  return tokens;
}

function classifyWord(word: string, wordIndex: number, program: string): CommandTokenKind {
  if (wordIndex === 0) return "program";
  if (word.startsWith("-")) return "flag";
  if (wordIndex === 1 && SUBCOMMAND_DRIVERS.has(program) && /^[a-z][a-z0-9:_-]*$/.test(word)) return "subcommand";
  if (looksLikePath(word)) return "path";
  return "plain";
}

/** 路径值得比普通参数亮一档：它通常是命令真正作用的对象。 */
function looksLikePath(word: string): boolean {
  if (word === "." || word === "..") return true;
  if (word.startsWith("~") || word.includes("/")) return true;
  return /^[\w@.-]+\.[A-Za-z][\w]{0,7}$/.test(word);
}

/** 引号未闭合时把剩余内容整段当字符串，好过把后面的字符错判成别的类别。 */
function readQuoted(command: string, start: number): string {
  const quote = command[start];
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index += 2;
      continue;
    }
    index += 1;
    if (char === quote) return command.slice(start, index);
  }
  return command.slice(start);
}

/** `$NAME`、`${NAME}`、`$1`、`$?`；`$` 后面接不认识的字符时只吃掉 `$`。 */
function readVariable(command: string, start: number): string {
  if (command[start + 1] === "{") {
    const end = command.indexOf("}", start + 2);
    return end === -1 ? command.slice(start) : command.slice(start, end + 1);
  }
  const name = takeWhile(command, start + 1, (char) => /[A-Za-z0-9_]/.test(char));
  if (name) return `$${name}`;
  const special = command[start + 1];
  return special && "?!@*#$-".includes(special) ? `$${special}` : "$";
}

function takeWhile(command: string, start: number, matches: (char: string) => boolean): string {
  let end = start;
  while (end < command.length && matches(command[end] ?? "")) end += 1;
  return command.slice(start, end);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isWordChar(char: string): boolean {
  return !isSpace(char) && char !== "'" && char !== '"' && char !== "`" && char !== "$" && !OPERATOR_CHARS.has(char);
}

function basename(word: string): string {
  return word.split("/").at(-1) ?? word;
}
