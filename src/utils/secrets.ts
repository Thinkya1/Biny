/**
 * 敏感信息保护。
 *
 * 三件事：判断路径是否属于受保护的凭据文件（工具层据此拒绝读写）、把文本/结构里的密钥
 * 打码后再落盘或展示、给 git 命令生成排除受保护路径的 pathspec。
 *
 * 策略一律「宁可多打码」：打码规则做不到零漏报，所以路径拦截、pathspec 过滤和输出打码是
 * 三层叠加的防线，不能只靠其中一层。
 */
import path from "node:path";
import { redactSecrets } from "./redaction.js";

export { redactSecrets } from "./redaction.js";

const protectedCredentialFiles = new Set([
  "config.json",
  ".envrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc"
]);

const protectedCredentialDirectories = new Set([
  ".biny",
  ".agent",
  ".ssh",
  ".aws",
  ".azure",
  ".direnv",
  ".gnupg"
]);

const protectedGitDirectories = [...protectedCredentialDirectories];

/**
 * 判断是否为受保护的凭据路径。除固定文件名外，还覆盖 `.env` 系列、`config.json.*`
 * 备份，以及路径中任意一段落在 `.ssh` / `.aws` 等目录里的情况。
 */
export function isProtectedCredentialPath(value: string): boolean {
  // 统一成 posix 分隔符再判断，Windows 路径和 `./` 前缀不能绕过检查。
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = path.posix.basename(normalized);
  return fileName === ".env"
    || fileName.startsWith(".env.")
    || fileName.startsWith("config.json.")
    || segments.some((segment) => protectedCredentialDirectories.has(segment))
    || protectedCredentialFiles.has(fileName);
}

/**
 * 生成一份可安全落盘/展示的副本，不改动原值。
 *
 * 相比纯文本打码，这里多了字段名这层信息：`apiKey`、`authorization` 之类字段下的值即使
 * 没有任何可识别前缀，也一律替换掉。
 */
export function redactSensitiveValue(value: unknown): unknown {
  return redactSensitiveValueInternal(value, new WeakSet<object>());
}

function redactSensitiveValueInternal(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  // 工具结果可能带循环引用，用祖先集合断环；只在递归路径上记录，兄弟节点之间互不影响。
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactSensitiveValueInternal(entry, ancestors));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveFieldName(key) ? "[redacted]" : redactSensitiveValueInternal(entry, ancestors)
    ]));
  } finally {
    ancestors.delete(value);
  }
}

/** 字段名判定：先去掉分隔符再小写，这样 `api-key`、`api_key`、`ApiKey` 都能一起命中。 */
function isSensitiveFieldName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "token"
    || normalized === "secret"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("password");
}

/** 用 git pathspec 直接排除受保护文件，让子进程根本不会把这些内容打印出来。 */
export function protectedGitPathspecs(): string[] {
  const fileNames = [...protectedCredentialFiles, ".env"];
  return [
    ...fileNames.flatMap((fileName) => [
      `:(exclude,glob)${fileName}`,
      `:(exclude,glob)**/${fileName}`
    ]),
    ":(exclude,glob).env.*",
    ":(exclude,glob)**/.env.*",
    ":(exclude,glob)config.json.*",
    ":(exclude,glob)**/config.json.*",
    ...protectedGitDirectories.flatMap((directory) => [
      `:(exclude,glob)${directory}/**`,
      `:(exclude,glob)**/${directory}/**`
    ])
  ];
}

/**
 * 兜底过滤：pathspec 之后理论上不该再出现受保护文件的 diff，这里按 diff 段再筛一遍。
 * 解析不出路径的段落一律丢弃（`paths !== undefined` 才保留），因为无法确认它安全。
 */
export function filterProtectedGitDiff(output: string): string {
  return output
    // 按 diff 段首行切分并保留分隔符（零宽前瞻），这样每段都自带自己的头部。
    .split(/(?=^diff --(?:git|cc|combined) )/m)
    .filter((section) => {
      if (!section.trim()) return true;
      const header = section.split("\n", 1)[0] ?? "";
      const paths = gitDiffHeaderPaths(header);
      return paths !== undefined && !paths.some(isProtectedGitPath);
    })
    .join("");
}

/**
 * 从 diff 头部取出涉及的路径。git 对含空格或特殊字符的路径会加引号并转义，所以 token
 * 既要匹配带引号形式也要匹配裸路径；`--cc` / `--combined`（合并提交）只有一个路径。
 */
function gitDiffHeaderPaths(header: string): string[] | undefined {
  const token = '("(?:\\\\.|[^"\\\\])*"|\\S+)';
  const regular = header.match(new RegExp(`^diff --git ${token} ${token}$`, "u"));
  if (regular) {
    const left = decodeGitPathToken(regular[1]);
    const right = decodeGitPathToken(regular[2]);
    return left && right ? [left.replace(/^a\//, ""), right.replace(/^b\//, "")] : undefined;
  }
  const combined = header.match(new RegExp(`^diff --(?:cc|combined) ${token}$`, "u"));
  if (!combined) return undefined;
  const decoded = decodeGitPathToken(combined[1]);
  return decoded ? [decoded] : undefined;
}

/** 带引号的路径用 JSON 解析还原转义；解析失败返回 undefined，上层会因此丢弃整段。 */
function decodeGitPathToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (!token.startsWith('"')) return token;
  try {
    const decoded = JSON.parse(token) as unknown;
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isProtectedGitPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return isProtectedCredentialPath(normalized)
    || normalized.split("/").some((segment) => segment === ".biny" || segment === ".agent");
}
