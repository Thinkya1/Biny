/**
 * 代码高亮。
 *
 * 只按需注册用得到的语言（走 highlight.js 的 core 入口而不是整包），避免把上百种语言
 * 都打进渲染进程的产物里。
 *
 * 识别不出语言或高亮抛错时，退回转义后的纯文本——高亮结果是要作为 HTML 插进 DOM 的，
 * 不能把未转义的文件内容直接交出去。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languageDefinitions = {
  bash,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml
};

for (const [name, definition] of Object.entries(languageDefinitions)) {
  hljs.registerLanguage(name, definition);
}

// 扩展名 → 已注册语言。多个扩展名可以复用同一套语法（如 .vue 用 xml、.zsh 用 bash）。
const languageByExtension: Record<string, string> = {
  bash: "bash",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash"
};

// Markdown 代码块的语言标注不一定和扩展名一致，这里补上常见写法。
const languageByFence: Record<string, string> = {
  "c++": "cpp",
  console: "bash",
  golang: "go",
  html: "xml",
  htm: "xml",
  shell: "bash",
  svg: "xml",
  ts: "typescript",
  zsh: "bash"
};

/**
 * 超过这个长度就不高亮。
 *
 * 流式输出时代码块每来一个增量都会重新高亮一次，长文本上这个开销会直接卡住渲染。
 */
const highlightLimit = 40_000;

export interface HighlightedCode {
  html: string;
  language?: string;
}

export function highlightWorkspaceFile(filePath: string, content: string): HighlightedCode {
  return highlight(content, languageForPath(filePath));
}

/** 高亮 Markdown 围栏代码块；`fence` 是 ``` 后面那段语言标注。 */
export function highlightFencedCode(content: string, fence?: string): HighlightedCode {
  return highlight(content, languageForFence(fence));
}

function highlight(content: string, language?: string): HighlightedCode {
  if (!language || content.length > highlightLimit) return { html: escapeHtml(content), language };
  try {
    return { html: hljs.highlight(content, { language }).value, language };
  } catch {
    return { html: escapeHtml(content), language };
  }
}

function languageForFence(fence?: string): string | undefined {
  const name = fence?.trim().toLocaleLowerCase();
  if (!name) return undefined;
  if (name in languageDefinitions) return name;
  return languageByFence[name] ?? languageByExtension[name];
}

function languageForPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "bash";
  const extension = name.split(".").at(-1);
  return extension ? languageByExtension[extension] : undefined;
}

/** 无高亮时也必须转义：返回值会以 innerHTML 的方式渲染。 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}
