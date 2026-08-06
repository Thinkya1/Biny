# Biny-Agent。

> 一个想法、半句话、一段粘贴——剩下交给 Biny。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区里运行：连接你自己的模型服务，在权限确认下读写文件、搜索代码、执行命令；会话保存在本机，随时可以恢复，而不是被锁在某个云端产品里。

> [!IMPORTANT]
> 利用空余时间持续开发中，如果有没有注意到的功能以及 bug 欢迎提交 issue。

## 功能

- **本地 Agent** —— 支持 macOS 桌面端、TUI 和 CLI，三种入口共用同一套 Agent Runtime 与 Session。
- **模型与 Provider** —— 支持主流模型服务、OpenAI-compatible / Anthropic-compatible 网关和 Ollama；支持流式输出、推理档位和用量统计。
- **工作区工具** —— 文件读写与补丁、代码搜索、Git、Shell、受管进程、联网搜索/抓取和 Todo。
- **安全与恢复** —— 统一权限确认、可选的 macOS 工作区沙箱、Git checkpoint/undo；异常中断后可恢复 Session，无法确认副作用的操作不会自动重试。
- **扩展能力** ——
  - Skill：已支持全局/项目目录扫描、显式调用和按需读取资源；生态兼容与复杂编排仍在完善。
  - MCP：已支持配置并连接启用的 stdio/http server、发现并调用工具；配置体验、跨服务兼容和异常恢复仍在完善。
  - Plugin、具名子代理和持久 Memory：已有基础能力，扩展 API 与管理体验仍在迭代。
- **交互模式** —— 支持 Chat / Plan、follow-up / steer，以及 Desktop 与 TUI 共用的 slash command。

## 快速开始

### 桌面端

从 [Releases](https://github.com/Thinkya1/Biny/releases) 下载对应架构的 DMG，打开后在 **设置 → 模型** 中连接模型，再选择项目开始任务。

### 终端

需要 Node.js LTS 和 pnpm 10：

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny && pnpm install
pnpm dev -- init
export DEEPSEEK_API_KEY="你的 key"
pnpm dev
```

单次任务：`biny run "总结当前项目并指出最重要的风险"`。`biny chat` 与直接运行 `biny` 都打开 TUI，完整命令见 `biny --help`。

### Harbor/Pier 评测

Biny 提供了 Harbor/Pier `BaseAgent` 适配器，可在隔离任务容器中执行 Biny，并将终态、session 和 token 用量交给外部 verifier。每次运行还会把 `biny-result.json` 和可下载的 `biny-session.jsonl` 放入 Harbor agent logs；session 下载失败不会改变任务评分。适配器源码位于 `benchmarks/harbor_adapter/`；任务容器需要预先提供 Biny、Node.js、配置和 Provider 凭据，适配器不会在 DeepSWE 离线容器中自动下载依赖。

机器化的一次性运行可以使用 `biny run --json --headless`；`--model` 接受已配置的模型 alias，`--max-steps` 和 `--soft-steps` 只覆盖本次运行。

```bash
harbor run \
  -p <dataset> \
  --agent benchmarks.harbor_adapter.biny_agent:BinyAgent \
  --model deepseek/deepseek-v4-flash \
  --n-concurrent 1 \
  --ae BINY_COMMAND=biny \
  --ae BINY_MODEL_ALIAS=deepseek-v4-flash \
  --ae BINY_MAX_STEPS=256 \
  --ae BINY_SOFT_STEPS=192 \
  --ae BINY_TIMEOUT_SEC=5400 \
  --ae DEEPSEEK_API_KEY=YOUR_API_KEY
```

如果 Harbor 传入了 `--model`，必须同时设置匹配的 `BINY_MODEL_ALIAS`，避免报告中的模型和 Biny 实际使用的模型不一致。`BINY_COMMAND` 默认是 `biny`，也可以指定为 `node /opt/biny/dist/cli/index.js`。

## 配置

桌面端在 **设置 → 模型** 中管理模型。CLI、TUI 和 Desktop 共用全局 `~/.biny/config.json`；项目运行参数可在 `<project>/.biny/settings.json` 中覆盖。API key 不写入 README、代码或示例快照：macOS 使用 Keychain，其他平台使用 `apiKeyEnv` 环境变量。

最小配置示例：

```json
{
  "defaultModel": "coder",
  "providers": {
    "deepseek": { "type": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "models": {
    "coder": { "provider": "deepseek", "model": "deepseek-v4-flash" }
  }
}
```

设置 `BINY_AGENT_DIR` 可将配置和运行数据切换到独立目录。

## 数据与会话

会话和 Memory 按项目保存在 `~/.biny/agent/`，附件与工具结果归档在项目 `.biny/`。会话正文仍是 JSONL；分支关系与标题、归档、未读等列表元数据保存在同项目的 catalog，运行状态保存在 run ledger，在途回合断点保存在 turnStore。`biny resume latest` 可恢复最近会话，Desktop 的“继续运行”会沿用断点和已完成工具步骤。

`biny sessions` 默认列出第一页；需要机器读取或继续翻页时使用 `--json`、`--limit <count>` 和返回的 `--cursor <cursor>`，`--parent <session-id>` 可只查看某个会话的直接分支。Desktop 侧栏首屏加载根会话，展开父会话时再按页加载子节点。Desktop、TUI 和 CLI 使用同一份历史；复制、编辑重发和 fork 会保留父会话关系，删除会话会同步清理正文、catalog、断点和 run ledger。

Desktop、TUI 和 `biny plan` 运行同一项目时，会通过本地 Unix socket attach 到同一个独立 Runtime Host，共享实时事件、权限请求和断点恢复；没有 owner 时会按项目自动启动 Host。一端退出不会复制出第二个 AgentSession。已有 Host 时，未带临时配置覆盖的 `biny run` 也会直接 attach。

桌面端切换模型时，如果发现驻留 Host 是旧版本且当前项目处于空闲状态，会自动替换 owner 并重试请求；运行中的任务不会被强制重启。

需要手动托管 owner 时可运行 `biny runtime-host --workspace-root <workspace> --persistence-root <data-root>`；通常不需要手动启动。

## 当前边界

- 项目仍在持续开发，部分桌面端入口和扩展能力会继续调整。
- 带 `--model`、步数、权限或 `--headless` 覆盖的 `biny run` 仍使用独立的一次性 runtime，不修改共享 Host。
- 本地构建不签名、不公证；公开发布需要单独配置 macOS signing / notarization。
- 暂无语音输入和实时语音对话。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

桌面端开发可使用 `pnpm desktop:dev`，实现和 IPC 说明见 [src/desktop/README.md](./src/desktop/README.md)。欢迎通过 Issue 或 PR 反馈，请勿提交 API key、token 或其他本地敏感配置。
