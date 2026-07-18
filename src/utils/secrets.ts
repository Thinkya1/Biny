import path from "node:path";

const protectedCredentialFiles = new Set([
  "agent.config.json",
  ".envrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc"
]);

const protectedCredentialDirectories = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".direnv",
  ".gnupg"
]);

const protectedGitDirectories = [...protectedCredentialDirectories, ".agent"];

export function isProtectedCredentialPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = path.posix.basename(normalized);
  return fileName === ".env"
    || fileName.startsWith(".env.")
    || fileName.startsWith("agent.config.json.")
    || segments.some((segment) => protectedCredentialDirectories.has(segment))
    || protectedCredentialFiles.has(fileName);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:aws_secret_access_key|_authToken)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/(["'](?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|token|secret|password)["']\s*:\s*["'])([^"']*)(["'])/gi, "$1[redacted]$3");
}

/**
 * Produces a persistence/display-safe clone without mutating the execution
 * value. Field names provide context that a standalone string does not, so an
 * opaque credential under `apiKey` or `authorization` is still removed even
 * when it has no recognizable token prefix.
 */
export function redactSensitiveValue(value: unknown): unknown {
  return redactSensitiveValueInternal(value, new WeakSet<object>());
}

function redactSensitiveValueInternal(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
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

/** Git pathspec exclusions keep protected file contents out of the child process output. */
export function protectedGitPathspecs(): string[] {
  const fileNames = [...protectedCredentialFiles, ".env"];
  return [
    ...fileNames.flatMap((fileName) => [
      `:(exclude,glob)${fileName}`,
      `:(exclude,glob)**/${fileName}`
    ]),
    ":(exclude,glob).env.*",
    ":(exclude,glob)**/.env.*",
    ":(exclude,glob)agent.config.json.*",
    ":(exclude,glob)**/agent.config.json.*",
    ...protectedGitDirectories.flatMap((directory) => [
      `:(exclude,glob)${directory}/**`,
      `:(exclude,glob)**/${directory}/**`
    ])
  ];
}

/** Defense in depth for diff forms that are not expected after pathspec filtering. */
export function filterProtectedGitDiff(output: string): string {
  return output
    .split(/(?=^diff --(?:git|cc|combined) )/m)
    .filter((section) => {
      if (!section.trim()) return true;
      const header = section.split("\n", 1)[0] ?? "";
      const paths = gitDiffHeaderPaths(header);
      return paths !== undefined && !paths.some(isProtectedGitPath);
    })
    .join("");
}

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
    || normalized.split("/").some((segment) => segment === ".agent");
}
