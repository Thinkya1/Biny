import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskRequest } from "../src/harness/TaskRequestFactory.js";

await testLaunchTaskGetsProjectAcceptanceCriteria();
await testOrdinaryChatHasNoInventedCriteria();

async function testLaunchTaskGetsProjectAcceptanceCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-request-"));
  try {
    await fs.mkdir(path.join(root, "backend", "src", "main", "java", "demo"), { recursive: true });
    await fs.mkdir(path.join(root, "frontend"), { recursive: true });
    await fs.writeFile(path.join(root, "backend", "pom.xml"), "<project/>\n");
    await fs.writeFile(path.join(root, "backend", "src", "main", "java", "demo", "Items.java"), [
      "@RestController",
      "@RequestMapping(\"/api/items\")",
      "class Items {",
      "  @GetMapping",
      "  public String list() { return \"ok\"; }",
      "}"
    ].join("\n"));
    await fs.writeFile(path.join(root, "frontend", "package.json"), JSON.stringify({
      scripts: { build: "vite build", dev: "vite" },
      devDependencies: { vite: "latest" }
    }));
    await fs.writeFile(path.join(root, "frontend", "vite.config.ts"), [
      "export default {",
      "  server: {",
      "    port: 3000,",
      "    proxy: { '/api': 'http://127.0.0.1:8080' }",
      "  }",
      "}"
    ].join("\n"));

    const request = await createTaskRequest(root, "把这个项目启动起来");
    const ids = new Set(request.acceptanceCriteria.map((criterion) => criterion.id));
    assert.equal(ids.has("backend-http-readiness"), true);
    assert.equal(ids.has("frontend-http-readiness"), true);
    assert.equal(ids.has("frontend-proxy-api"), true);
    assert.equal(request.acceptanceCriteria.some((criterion) => criterion.kind === "managed_process" && criterion.cwd === "backend" && criterion.requireHttpReadiness), true);
    assert.equal(request.acceptanceCriteria.some((criterion) => criterion.kind === "managed_process" && criterion.cwd === "frontend" && criterion.requireHttpReadiness), true);
    assert.equal(request.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.cwd === "backend"), true);
    assert.equal(request.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.cwd === "frontend"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testOrdinaryChatHasNoInventedCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-request-chat-"));
  try {
    const request = await createTaskRequest(root, "解释一下这个函数");
    assert.deepEqual(request.acceptanceCriteria, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
