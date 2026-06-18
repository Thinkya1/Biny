export function isIgnoredPath(relativePath: string, ignore: string[]): boolean {
  const normalized = relativePath.split(/[\\/]+/).filter(Boolean);
  return normalized.some((segment) => ignore.includes(segment));
}
