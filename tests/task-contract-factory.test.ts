import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskContract } from "../src/harness/TaskContractFactory.js";

await testLaunchTaskGetsProjectAcceptanceCriteria();
await testCodeTaskGetsDeterministicChecks();
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

    const contract = await createTaskContract(root, "把这个项目启动起来");
    const ids = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
    assert.equal(ids.has("backend-http-readiness"), true);
    assert.equal(ids.has("frontend-http-readiness"), true);
    assert.equal(ids.has("frontend-proxy-api"), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "managed_process" && criterion.cwd === "backend" && criterion.requireHttpReadiness), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "managed_process" && criterion.cwd === "frontend" && criterion.requireHttpReadiness), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.cwd === "backend"), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.cwd === "frontend"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testOrdinaryChatHasNoInventedCriteria(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-request-chat-"));
  try {
    const contract = await createTaskContract(root, "解释一下这个函数");
    assert.deepEqual(contract.acceptanceCriteria, []);
    assert.equal(contract.verificationMode, "model_only");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testCodeTaskGetsDeterministicChecks(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-task-request-code-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "node -e 'process.exit(0)'",
        test: "node -e 'process.exit(0)'"
      }
    }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const contract = await createTaskContract(root, "修复这个函数");
    assert.equal(contract.verificationMode, "deterministic");
    assert.equal(contract.taskType, "code_change");
    assert.equal(contract.plan.some((item) => item.id === "implement" && item.required), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "workspace_changed"), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.command === "pnpm run typecheck"), true);
    assert.equal(contract.acceptanceCriteria.some((criterion) => criterion.kind === "command_succeeded" && criterion.command === "pnpm run test"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
