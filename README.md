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
- Agent loop 由 Biny 自己驱动：每一步是一次独立的 provider 请求，步与步之间会按预算把较早的工具结果换成占位符，让长回合不至于在中途撑爆上下文窗口；模型输出被 token 上限截断时立即停止本回合，不会在半句话上继续推理。用量按步记账，回合级数字是各步合计；
- 支持 Plan 模式：先生成计划，不执行会产生副作用的操作；
- 模型配置包含 `contextWindow`、`maxOutputTokens`、`capabilities` 和 `reasoning` 元数据。上下文预算会按当前模型的上下文窗口与输出上限计算；`reasoning.mapping` 与 `reasoning.budgetTokens` 将统一的 `minimal`/`low`/`medium`/`high`/`xhigh`/`max` 档位映射到 Provider 原生参数；旧的 `thinking` 字段继续兼容；
- Provider 定义统一协议、认证、兼容性和请求重试设置；Anthropic 原生 API、Anthropic-compatible 网关、OpenAI-compatible 网关、本地 Ollama/LM Studio/LocalAI 都通过同一套模型目录和连接配置处理；可通过 `ModelManager.refreshModelCatalog()` 拉取 Provider 的 `/models` 动态目录；
- 支持 Workspace Skill、Plugin、MCP stdio server 和有界 Subagent；子 Agent 会继承当前会话权限，只有 `full-access` 模式才可修改工作区并执行有限的 build/test/lint/typecheck 命令；`maxCostUsd` 是在每个模型 step 结束后按 provider usage 检查的软阈值，当前 step 可能使总成本超过阈值（启用时需配置输入、输出、缓存读和缓存写价格）。
- 支持具名子代理定义（参考 pi 的 agents 设计）：`.biny/agents/*.md`（兼容 `.agent/agents`，目录可用 `extensions.subagent.agentPaths` 配置）或全局 `~/.biny/agents/*.md`，frontmatter 提供 `name`/`description`/`tools`/`model`，正文即该子代理的附加 system prompt。模型通过 `delegate_task` 的 `agent` 参数选用；`tools` 只在全局 `allowedTools` 内收窄、`model` 必须是已配置的模型别名，访问模式仍由父会话权限决定。定义在每次委派时重新读取，会话期间可编辑生效；`/subagent agents` 列出当前定义。
- 持久记忆（`.agent/memory`）除了任务成功后的自动抽取，还提供显式入口：模型可用 `save_memory`/`recall_memory` 工具主动沉淀与检索记忆，用户可用 `/memory list|show|add|forget|search|compact` 管理话题文件；相关记忆按关键词检索注入 system prompt 的 `Stable project memory` 段，中文查询按汉字 bigram 切词参与匹配。`context.memory` 支持 `autoRemember`（任务成功后是否自动沉淀）、`maxRecalled`（每轮注入条数，1-20）与 `model`（记忆抽取/整理的专用模型别名）；`compact` 用模型逐话题合并重复条目。桌面端设置的「记忆」页提供同能力的图形界面：开关、检索条数、自动总结、专用模型、一键整理、统计、条目增删与搜索。另支持全局指令文件 `~/.biny/AGENTS.md`（对齐 pi 的全局 AGENTS.md），在项目 `AGENTS.md` 之前作为基线注入。
- 项目级任务经过 attempt、验收、反馈和重试链路；任务默认受总步骤、总 wall time、总 token 和可选成本预算约束，只有模型正常停止且全部验收条件通过才会完成。
- 长期服务使用 `start_process`、`process_status`、`read_process_output`、`stop_process` 和 `list_processes` 管理，支持 HTTP/TCP/log readiness；普通 `run_command` 只用于有界命令。
- 内置工具遵守取消信号；Plugin、MCP 等外部工具采用 best-effort 取消。若外部工具在有界 drain 后仍未结束，当前调用会明确标记为已隔离，AgentSession 会拒绝新的执行操作，直到迟到的外部调用真正 settle，避免副作用重叠。
- 文件读取、编辑和权限 Diff 单文件上限为 1 MiB；搜索只扫描每个文件的前 1 MiB，并在结果中标记截断文件。单个 turn 默认最多将 128 KiB 的累计工具结果放入模型上下文，之后的完整结果会脱离会话 JSONL 存入 `.agent/tool-results`，模型仅收到路径和头尾预览；预算按真正进入上下文的字节计算，耗尽后预览也会收窄到只剩引用，模型可用 `read_tool_result` 按 offset/length 取回归档原文。该目录被 workspace ignore 规则挡在普通文件工具之外，`read_tool_result` 只接受归档引用形态的路径，并保留最近 512 份归档。可用 `context.maxTurnToolResultBytes` 调整预算。写入与编辑使用同目录事务式替换，且把真正执行绑定到已审批的文件快照；`write_file` 会安全创建缺失父目录，`multi_edit`/`apply_patch` 支持原子文本修改，`delete_file`/`move_file` 会绑定准备阶段快照且不覆盖已存在目标；提交窗口检测到外部写入时会保留或恢复外部版本，而不是静默覆盖。
- `web_fetch` 抓取公开网页正文（HTML 转文本，支持 offset/length 分页）。目标地址先解析域名再逐个校验解析出的 IP，私网、环回、链路本地（云实例元数据）、CGNAT 和组播一律拒绝，跳转逐跳重新校验，响应按实际读到的字节数收口。可用 `web.fetch.allowPrivateNetwork` 为本地开发服务放行；`maxBytes`、`maxRedirects`、`timeoutMs` 均可配置。
- `update_todos` 让模型维护跨回合的计划清单：整份替换、至多一项 `in_progress`、每回合注入 system prompt，因此历史压缩不会让它丢失，落盘在 `.agent/todos` 所以恢复会话后仍在。
- 写入/编辑成功后自动跑项目自己的检查并把结果附在该次工具结果上，让"改错了"在下一步就被看见。`diagnostics.commands` 按扩展名配置命令；`autoDetect` 只认项目本地已装好的 `node_modules/.bin/tsc`，不存在就跳过，绝不走 `npx` 之类会联网安装的路径。同一条命令不并发执行，并行编辑会合并到同一轮。
- 每个回合首次改动工作区前自动建一个快照，`/undo` 可回退（`/undo list` 查看）。快照用独立临时索引加 `commit-tree`，挂在 `refs/biny/checkpoints/*`：用户的暂存区、HEAD、分支历史和 `git log` 全都不受影响，`.agent` 整个排除在外。恢复用临时索引 `checkout-index` 写回，快照之后新建的文件移到 `.agent/undo-trash/<时间戳>/` 而不是删除。仅在 git 仓库内可用，可用 `checkpoints.enabled` 关闭。
- `git_commit` 只提交显式给出的路径，没有"全部提交"选项，且按高风险确认。
- `sandbox.mode` 设为 `workspace-write` 时，`run_command` 经 macOS seatbelt 执行：内核层面只允许写工作区、临时目录和常见缓存目录，`allowNetwork: false` 时禁网。这是独立于命令字符串判定的第二道边界，判定被绕过也仍然拦得住。目前只有 macOS 有实现，其他平台会在工具结果里如实说明未生效。
- `hooks.beforeTool` / `hooks.afterTool` 按工具名和扩展名匹配执行本地命令：前者非零退出会阻止该次调用并把输出作为拒绝理由回给模型，后者的输出附在结果上。钩子以用户权限执行、不经过权限确认 —— 配置一条钩子等同于信任那条命令。
- 回合按步落盘在途 context（`.agent/turns`），被打断后 CLI 的 `/continue` 可以从最后一个完成的步继续，已完成步骤的工具结果原样带回，不需要重跑。
- `/fork [session] [upToEvent]` 从某个时点分叉出一条新会话用于对比探索，原会话不受影响；截断点会向前对齐，绝不停在 tool_call 和它的 tool_result 中间。
- 超过大小上限的会话不再打不开：读取路径改为读回尾部并标注截断，最近的历史仍然可用；校验与写入路径保持严格。
- `biny eval run` 跑内置评测集并输出 JSON 报告，`biny eval compare <baseline> <candidate>` 对照两次运行的通过率、步数、token 与成本。只比较两边都跑过的任务，任一任务缺价格就不给总成本。
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

模型能力和 Provider 兼容设置可以直接写入 `agent.config.json`。`contextWindow` 是模型上限，`context.maxInputTokens` 是本地预算上限，`context.maxTurnToolResultBytes` 限制一次 turn 内联给模型的累计工具输出（默认 131072 字节）；实际输入预算会为模型输出预留空间：

```json
{
  "providers": {
    "gateway": {
      "type": "openai-compatible",
      "baseUrl": "https://example.test/v1",
      "apiKeyEnv": "GATEWAY_API_KEY",
      "retry": { "maxAttempts": 3, "initialDelayMs": 250, "maxDelayMs": 4000 },
      "compatibility": { "supportsDeveloperRole": false, "maxTokensField": "max_completion_tokens" },
      "modelsEndpoint": "https://example.test/v1/models"
    }
  },
  "models": {
    "gateway-coder": {
      "provider": "gateway",
      "model": "coder-latest",
      "contextWindow": 131072,
      "maxOutputTokens": 16384,
      "capabilities": { "tools": true, "reasoning": true, "vision": true },
      "reasoning": {
        "efforts": ["low", "high", "max"],
        "defaultEffort": "high",
        "mapping": { "low": "low", "high": "medium", "max": "high" },
        "budgetTokens": { "low": 2048, "high": 8192, "max": 16384 }
      }
    }
  }
}
```

Skill 采用渐进式披露：启动时只把每个技能的 `name`/`description` 元数据注入 system prompt，完整指令由模型在需要时调用 `invoke_skill` 工具加载。技能是包含 `SKILL.md`（可带 YAML frontmatter 的 `name:`、`description:`）的目录，也兼容裸 `.md` 文件；项目级默认从 `.biny/skills`（兼容旧的 `.agent/skills`）加载，全局技能放在 `~/.biny/skills`，同名时项目级覆盖全局。MCP 服务器支持 `stdio`（`command`）与 `http`（`url`，优先 streamable HTTP、失败回退 SSE）两种传输；配置值支持 `${ENV_VAR}` / `${ENV_VAR:-default}` 环境变量展开，可用 `timeoutMs` 设置每服务器请求超时。单个服务器连接失败只会记录在 `/mcp` 状态里，不影响其他服务器和会话启动；连接断开后下一次工具调用会自动重连，也可以用 `/mcp reconnect <server>` 手动重连。除工具外还接入了协议的其余能力：`tools/list_changed` 通知会动态刷新工具列表，服务器 `instructions` 会注入 system prompt，资源可通过内置的 `mcp_list_resources` / `mcp_read_resource` 工具浏览和读取，prompts 会在 `/mcp` 报告中列出。Plugin 会以当前进程权限执行本地 JavaScript，能够直接访问文件系统和环境变量，且没有沙箱，因此默认不自动加载；只有写入 `extensions.plugins` 的工作区内路径才会启用，并必须视为完全受信任代码。项目内 Skill、Plugin 与 MCP `cwd` 都拒绝越出工作区的路径和符号链接；传给 Plugin 的配置副本会移除 provider key、OAuth refresh token 与 MCP 环境变量，这只用于避免上下文意外泄漏，不构成安全隔离。

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
- 图片和音频附件在模型声明支持 `vision`/`audio` 时会作为原生 `file` message part 发送；不支持的模型仍保留安全 `@attachments/` 路径供工具读取。

## 快速开始

### 使用 macOS 桌面端

从 [GitHub Releases](https://github.com/Thinkya1/Biny/releases) 下载适合你 Mac 的 DMG 安装包。安装包已包含运行所需的应用运行时，不需要安装 Node.js、pnpm 或 CLI：

1. 打开 `.dmg`，将 `Biny` 拖入“应用程序”文件夹；或解压 `.zip` 后移动 `Biny.app`。
2. Apple 芯片 Mac 请选择 `arm64`，Intel Mac 请选择 `x64`。
3. 首次打开后，进入“设置 → 模型”，连接一个模型并测试连接。
4. 打开项目，开始任务。

Release 工作流要求配置 macOS Developer ID 证书、密码和 Apple 公证凭据后再构建签名安装包；本地执行 `pnpm desktop:dist` 仍不会自动签名。如果 macOS 提示无法验证开发者，请使用 GitHub Release 中的签名产物，或配置本机 `electron-builder` 签名环境。

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

桌面端通过“设置 → 模型”管理连接、默认模型和密钥。API key 与 OAuth 凭据由 macOS 系统钥匙串保护。

**项目会话**（Desktop 与 TUI/CLI 共用）写在打开的项目目录：

```text
<project>/.agent/sessions/   项目问答历史
<project>/.agent/            runs、tasks、logs、memory 等运行时数据
```

Desktop 与 TUI/CLI 可以同时打开同一个项目；当前按 Pi 的单进程、单 AgentSession 模型运行，执行互斥按 Session 生效：同一个 Session 同一时刻只能由一个运行时执行，另一个运行时会返回明确的占用提示，不应手动删除其锁文件。不同 Session 可以并行执行。TODO：后续引入 SessionHost 后再支持 Desktop/TUI 跨进程共同挂载同一 live Session。

**桌面端全局数据**仍在用户数据目录：

```text
~/Library/Application Support/Biny/workspaces/default/
  agent.config.json                 模型设置（不含密钥）
  credentials.json                  经系统保护的凭据
  desktop-state.json                项目列表与窗口 UI 状态
  global/.agent/sessions/           非项目会话
  projects/<project-id>/.agent/attachments/  桌面端附件（不写入项目）
```

升级后，旧版桌面端写在用户数据目录下的项目会话会在打开项目时合并到 `<project>/.agent/`（目标已有文件优先）；附件与模型配置仍留在用户数据目录。CLI/TUI 建议只在配置中填写 `apiKeyEnv`，把真实 key 放进环境变量；`biny doctor` 会提示 inline key 风险，但不会输出 key 内容。配置文件按 `0600` 保存并采用原子替换，符号链接或硬链接配置会被拒绝。

## 当前边界

- 本地构建不会自动签名或公证；公开 Release 需要配置 GitHub Actions 的 macOS signing/notarization secrets；
- 语音输入、麦克风录音和实时语音对话尚未实现；当前只支持把已有音频附件作为模型输入；
- 命令区域仍是实时日志视图，不是完整 PTY 终端模拟器；
- 部分桌面端导航入口仍在开发中，会明确标注为暂未实现。

## 开发与贡献

```bash
pnpm test
pnpm typecheck
pnpm build
```

欢迎通过 Issue 或 Pull Request 提交反馈和改进。请勿提交 API key、token 或其他本地敏感配置。

桌面端实现与 IPC 协议见 [src/desktop/README.md](./src/desktop/README.md)。
