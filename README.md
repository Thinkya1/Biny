# Biny

> 你的项目，你的 Agent。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区中运行。你可以连接自己的模型服务，在权限确认下读取文件、搜索代码、执行命令和修改项目；会话可以在本机恢复，而不是被锁定在某个云端产品里。

> [!IMPORTANT]
> Biny 正在持续开发中。桌面端、CLI 和模型接入仍会改进，建议先在副本或非关键项目中体验。

## 为什么是 Biny

- **本地优先**：项目文件留在你的电脑上，模型由你自行选择和配置。
- **模型不设限**：支持 DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama 及 OpenAI-compatible 服务。
- **执行可控**：读取、写入、编辑和命令执行都经过统一权限策略；需要审批的高风险操作必须完整输入 `yes`，不会因空 Enter 或误按单键执行。
- **任务可恢复**：消息、工具调用、验收证据、自动续跑 attempt 和终态原因保存在本机；运行时重启后，未完成任务会明确进入可继续状态。

## 使用方式

| 入口 | 适合什么 | 说明 |
| --- | --- | --- |
| **Desktop** | 日常使用、管理项目与模型 | macOS 图形应用，提供项目、会话、文件、模型和权限界面。 |
| **TUI / CLI** | 在终端中工作或执行单次任务 | 在当前工作区启动交互界面，或通过 `biny run` 执行任务。 |

## 当前能力

### Agent

- 使用文件、搜索、Git、Shell 和联网搜索工具完成任务；`web_search` 默认使用 AnySearch API，也支持无需密钥的 DuckDuckGo 和 Brave Search API；AnySearch 通过 `ANYSEARCH_API_KEY` 环境变量读取密钥，也可匿名访问；
- 支持有并发上限、公平冲突排序和取消传播的工具调用，以及流式输出、推理档位和用量统计；单次模型 attempt 达到步骤上限时会返回未完成并自动续跑，而不是误报完成；
- 支持 Plan 模式：先生成计划，不执行会产生副作用的操作；
- 支持 Workspace Skill、Plugin、MCP stdio server 和有界 Subagent；子 Agent 可在统一权限策略下读取、修改工作区并执行有限的 build/test/lint/typecheck 命令；`maxCostUsd` 是在每个模型 step 结束后按 provider usage 检查的软阈值，当前 step 可能使总成本超过阈值（启用时需配置输入、输出、缓存读和缓存写价格）。
- 项目级任务经过 attempt、验收、反馈和重试链路；任务默认受总步骤、总 wall time、总 token 和可选成本预算约束，只有模型正常停止且全部验收条件通过才会完成。
- 长期服务使用 `start_process`、`process_status`、`read_process_output`、`stop_process` 和 `list_processes` 管理，支持 HTTP/TCP/log readiness；普通 `run_command` 只用于有界命令。
- 内置工具遵守取消信号；Plugin、MCP 等外部工具采用 best-effort 取消。若外部工具在有界 drain 后仍未结束，当前调用会明确标记为已隔离，AgentSession 会拒绝新的执行操作，直到迟到的外部调用真正 settle，避免副作用重叠。
- 文件读取、编辑和权限 Diff 单文件上限为 1 MiB；搜索只扫描每个文件的前 1 MiB，并在结果中标记截断文件。写入与编辑使用同目录事务式替换，且把真正执行绑定到已审批的文件快照；`write_file` 会安全创建缺失父目录，`multi_edit`/`apply_patch` 支持原子文本修改，`delete_file`/`move_file` 会绑定准备阶段快照且不覆盖已存在目标；提交窗口检测到外部写入时会保留或恢复外部版本，而不是静默覆盖。
- CLI 的 `run`、`plan`、`chat` 及其中的长操作会把第一次 Ctrl+C 传递为协作式取消，并在操作结束后清理信号监听。

如果工作区配置覆盖了默认值，可在 `agent.config.json` 的 `web.search` 中显式设置 AnySearch 和密钥环境变量：

```json
{
  "web": {
    "search": {
      "provider": "anysearch",
      "apiKeyEnv": "ANYSEARCH_API_KEY"
    }
  }
}
```

然后在启动 Biny 的环境中设置 `ANYSEARCH_API_KEY`。不设置 `apiKeyEnv` 时，AnySearch 也可以使用匿名额度。

Workspace Skill 默认从 `.agent/skills` 加载。Plugin 会以当前进程权限执行本地 JavaScript，能够直接访问文件系统和环境变量，且没有沙箱，因此默认不自动加载；只有写入 `extensions.plugins` 的工作区内路径才会启用，并必须视为完全受信任代码。Skill、Plugin 与 MCP `cwd` 都拒绝越出工作区的路径和符号链接；传给 Plugin 的配置副本会移除 provider key、OAuth refresh token 与 MCP 环境变量，这只用于避免上下文意外泄漏，不构成安全隔离。

下面是开启 Subagent 成本软阈值的最小配置片段；将它合并进 `agent.config.json`，价格单位均为每百万 token 的美元价格：

```json
{
  "agent": {
    "maxSteps": 32,
    "maxAttempts": 3,
    "maxTaskSteps": 96,
    "maxWallTimeMs": 1800000,
    "maxTotalTokens": 500000,
    "maxConcurrentTools": 4,
    "maxQueuedToolCalls": 64
  },
  "models": {
    "reviewer": {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "pricing": {
        "inputPerMillionTokens": 0.27,
        "outputPerMillionTokens": 1.1,
        "cacheReadPerMillionTokens": 0.07,
        "cacheWritePerMillionTokens": 0.27
      }
    }
  },
  "extensions": {
    "subagent": {
      "model": "reviewer",
      "maxSteps": 16,
      "maxOutputTokens": 8000,
      "maxConcurrentSubagents": 2,
      "maxPendingSubagents": 16,
      "timeoutMs": 300000,
      "maxCostUsd": 0.02,
      "allowedTools": [
        "read_file",
        "list_files",
        "search_files",
        "grep_search",
        "git_status",
        "git_diff",
        "write_file",
        "edit_file",
        "multi_edit",
        "delete_file",
        "apply_patch",
        "move_file",
        "run_command"
      ]
    }
  }
}
```

旧配置会自动补齐上述默认值。`agent.maxSteps` 是单 attempt 的 circuit breaker；`maxAttempts`、`maxTaskSteps`、`maxWallTimeMs`、`maxTotalTokens` 和可选的 `agent.maxCostUsd` 约束整个任务。启用主任务成本预算时，默认模型同样必须配置完整价格。Subagent 默认最多并行 2 个、等待队列最多 16 个。CLI 中 `/subagent <task>` 会前台等待结果；`/subagent start <task>` 会立即返回 task ID 并在后台执行，因此可以继续用 `/subagent status` 查看任务历史，或用 `/subagent cancel <task-id>` 取消仍在等待或运行的任务。`agent.maxConcurrentTools` 控制并行进入工具管线的调用数，`agent.maxQueuedToolCalls` 限制从 schema/扩展解析、权限等待到实际执行的整条管线队列；队列满时调用会收到明确错误，资源冲突的工具按公平顺序等待。`/status` 会显示这些调度上限。Agent/Subagent 调度配置在 runtime 创建时读取，修改后需重启 CLI/TUI，或在 Desktop 中重新打开对应项目 runtime。

### Desktop

- 打开和管理本地项目、会话与附件；
- 在“设置 → 模型”中连接 API、本地模型或账号订阅，并测试连接；
- 展示消息、工具过程、命令输出、权限请求和文件 Diff；
- 支持 DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama 等厂商图标与接入方式。

## 快速开始

### 使用 macOS 桌面端

从 [GitHub Releases](https://github.com/Thinkya1/Biny/releases) 下载适合你 Mac 的 DMG 安装包。安装包已包含运行所需的应用运行时，不需要安装 Node.js、pnpm 或 CLI：

1. 打开 `.dmg`，将 `Biny` 拖入“应用程序”文件夹；或解压 `.zip` 后移动 `Biny.app`。
2. Apple 芯片 Mac 请选择 `arm64`，Intel Mac 请选择 `x64`。
3. 首次打开后，进入“设置 → 模型”，连接一个模型并测试连接。
4. 打开项目，开始任务。

当前安装包未签名或公证。如果 macOS 提示无法验证开发者，请在“系统设置 → 隐私与安全性”中允许打开 Biny。

### 从终端运行

需要 Node.js LTS、pnpm 10 和一个模型 API key。以下示例使用 DeepSeek：

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny
pnpm install
pnpm dev -- init
export DEEPSEEK_API_KEY="你的 DeepSeek API key"
pnpm dev
```

`pnpm dev` 默认打开 TUI。查看完整终端命令可运行 `biny --help`；常用单次任务形式为：

```bash
biny run "总结当前项目并指出最重要的风险"
```

## 模型与数据

桌面端通过“设置 → 模型”管理连接、默认模型和密钥。API key 与 OAuth 凭据由 macOS 系统钥匙串保护；模型设置、会话、附件和运行记录保存在用户数据目录，项目文件夹不会被桌面端写入这些应用数据。

```text
~/Library/Application Support/Biny/workspaces/default/
  agent.config.json       模型设置（不含密钥）
  credentials.json        经系统保护的凭据
  projects/<project-id>/  会话、附件、记忆、任务、托管进程和运行记录
```

升级后，旧版桌面端的配置和会话会自动复制到新位置，原文件会保留。CLI/TUI 仍使用当前工作区中的 `agent.config.json` 和 `.agent/`；它们与桌面端数据相互隔离。CLI/TUI 建议只在配置中填写 `apiKeyEnv`，把真实 key 放进环境变量；`biny doctor` 会提示 inline key 风险，但不会输出 key 内容。配置文件按 `0600` 保存并采用原子替换，符号链接或硬链接配置会被拒绝。

## 当前边界

- 本地安装包尚未签名或公证；
- 图片附件目前以安全路径交给文本 Agent，尚未作为原生多模态消息发送；
- 部分桌面端导航入口仍在开发中，会明确标注为暂未实现。

## 开发与贡献

```bash
pnpm test
pnpm typecheck
pnpm build
```

欢迎通过 Issue 或 Pull Request 提交反馈和改进。请勿提交 API key、token 或其他本地敏感配置。

桌面端实现与 IPC 协议见 [src/desktop/README.md](./src/desktop/README.md)。
