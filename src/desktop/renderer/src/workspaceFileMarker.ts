export type WorkspaceFileMarkerTone =
  | "config"
  | "container"
  | "data"
  | "document"
  | "file"
  | "git"
  | "image"
  | "javascript"
  | "json"
  | "markdown"
  | "markup"
  | "python"
  | "shell"
  | "style"
  | "systems"
  | "text"
  | "typescript"
  | "yaml";

export interface WorkspaceFileMarker {
  label: string;
  tone: WorkspaceFileMarkerTone;
}

const namedMarkers: Readonly<Record<string, WorkspaceFileMarker>> = {
  dockerfile: { label: "DK", tone: "container" },
  makefile: { label: "MK", tone: "config" },
  license: { label: "TXT", tone: "text" }
};

const extensionMarkers: Readonly<Record<string, WorkspaceFileMarker>> = {
  bash: { label: "SH", tone: "shell" },
  bmp: { label: "IMG", tone: "image" },
  c: { label: "C", tone: "systems" },
  cc: { label: "C+", tone: "systems" },
  cpp: { label: "C+", tone: "systems" },
  css: { label: "CSS", tone: "style" },
  csv: { label: "CSV", tone: "data" },
  db: { label: "DB", tone: "data" },
  doc: { label: "DOC", tone: "document" },
  docx: { label: "DOC", tone: "document" },
  gif: { label: "GIF", tone: "image" },
  go: { label: "GO", tone: "systems" },
  h: { label: "H", tone: "systems" },
  hpp: { label: "H+", tone: "systems" },
  htm: { label: "<>", tone: "markup" },
  html: { label: "<>", tone: "markup" },
  ini: { label: "INI", tone: "config" },
  java: { label: "JV", tone: "systems" },
  jpeg: { label: "IMG", tone: "image" },
  jpg: { label: "IMG", tone: "image" },
  js: { label: "JS", tone: "javascript" },
  json: { label: "{}", tone: "json" },
  jsonc: { label: "{}", tone: "json" },
  jsx: { label: "JSX", tone: "javascript" },
  less: { label: "CSS", tone: "style" },
  log: { label: "LOG", tone: "text" },
  md: { label: "MD", tone: "markdown" },
  mdx: { label: "MDX", tone: "markdown" },
  mjs: { label: "JS", tone: "javascript" },
  mov: { label: "MOV", tone: "image" },
  mp3: { label: "MP3", tone: "image" },
  mp4: { label: "MP4", tone: "image" },
  pdf: { label: "PDF", tone: "document" },
  png: { label: "IMG", tone: "image" },
  ppt: { label: "PPT", tone: "document" },
  pptx: { label: "PPT", tone: "document" },
  py: { label: "PY", tone: "python" },
  rs: { label: "RS", tone: "systems" },
  sass: { label: "CSS", tone: "style" },
  scss: { label: "CSS", tone: "style" },
  sh: { label: "SH", tone: "shell" },
  sqlite: { label: "DB", tone: "data" },
  svg: { label: "SVG", tone: "markup" },
  toml: { label: "TOM", tone: "config" },
  ts: { label: "TS", tone: "typescript" },
  tsv: { label: "TSV", tone: "data" },
  tsx: { label: "TSX", tone: "typescript" },
  txt: { label: "TXT", tone: "text" },
  vue: { label: "VUE", tone: "markup" },
  webp: { label: "IMG", tone: "image" },
  xls: { label: "XLS", tone: "document" },
  xlsx: { label: "XLS", tone: "document" },
  xml: { label: "XML", tone: "markup" },
  yaml: { label: "YML", tone: "yaml" },
  yml: { label: "YML", tone: "yaml" },
  zsh: { label: "SH", tone: "shell" }
};

export function workspaceFileMarker(name: string): WorkspaceFileMarker {
  const lowerName = name.toLocaleLowerCase();
  if (lowerName === ".gitignore" || lowerName === ".gitattributes" || lowerName === ".gitmodules") {
    return { label: "◆", tone: "git" };
  }
  if (lowerName === ".env" || lowerName.startsWith(".env.")) return { label: "ENV", tone: "config" };
  const namedMarker = namedMarkers[lowerName];
  if (namedMarker) return namedMarker;
  const lastDot = lowerName.lastIndexOf(".");
  const extension = lastDot > 0 ? lowerName.slice(lastDot + 1) : "";
  const extensionMarker = extensionMarkers[extension];
  if (extensionMarker) return extensionMarker;
  return { label: extension ? extension.slice(0, 3).toLocaleUpperCase() : "FILE", tone: "file" };
}
