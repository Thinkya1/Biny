import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../src/workspace/resolvePath.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-path-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-outside-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"));
    await mkdir(path.join(workspaceRoot, "ignored"));
    await writeFile(path.join(workspaceRoot, "src", "entry.ts"), "export {};\n");
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside\n");
    await symlink(path.join(workspaceRoot, "src"), path.join(workspaceRoot, "inside"));
    await symlink(outsideRoot, path.join(workspaceRoot, "outside"));
    await symlink(path.join(outsideRoot, "missing.txt"), path.join(workspaceRoot, "dangling"));
    await symlink(path.join(workspaceRoot, "ignored"), path.join(workspaceRoot, "aliased-ignored"));
    const canonicalWorkspace = await realpath(workspaceRoot);

    assert.equal(resolveWorkspacePath(workspaceRoot, "src/entry.ts", ["ignored"]), path.join(canonicalWorkspace, "src", "entry.ts"));
    assert.equal(resolveWorkspacePath(workspaceRoot, "inside/entry.ts", ["ignored"]), path.join(canonicalWorkspace, "src", "entry.ts"));
    assert.equal(resolveWorkspaceDirectory(workspaceRoot, ".", ["ignored"]), canonicalWorkspace);
    assert.equal(toWorkspaceRelative(workspaceRoot, path.join(workspaceRoot, "inside", "entry.ts")), "src/entry.ts");

    assert.throws(() => resolveWorkspacePath(workspaceRoot, ".", []), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "../secret.txt", []), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "outside/secret.txt", []), /symbolic link/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "dangling", []), /dangling symbolic link/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "ignored/file.ts", ["ignored"]), /ignored by workspace policy/);
    assert.throws(() => resolveWorkspacePath(workspaceRoot, "aliased-ignored/file.ts", ["ignored"]), /resolves to a location ignored/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

await main();
