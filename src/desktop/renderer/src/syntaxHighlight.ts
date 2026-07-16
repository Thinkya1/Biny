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

export interface HighlightedCode {
  html: string;
  language?: string;
}

export function highlightWorkspaceFile(filePath: string, content: string): HighlightedCode {
  const language = languageForPath(filePath);
  if (!language) return { html: escapeHtml(content) };
  try {
    return { html: hljs.highlight(content, { language }).value, language };
  } catch {
    return { html: escapeHtml(content), language };
  }
}

function languageForPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).at(-1)?.toLocaleLowerCase() ?? "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "bash";
  const extension = name.split(".").at(-1);
  return extension ? languageByExtension[extension] : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}
