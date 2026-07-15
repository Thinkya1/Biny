# Biny

> 面向本地工作区的 AI Agent：在终端中完成编码、研究、文件处理与日常工程任务。

Biny 是一个使用 TypeScript 构建的本地桌面助手。它直接运行在你的工作区中，通过模型、工具、权限和会话系统，把一次性的问答变成可恢复、可审计的工作流。

Biny 不绑定单一模型或云平台，支持 DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama 以及通用 OpenAI-compatible endpoint。它提供 macOS Electron 桌面端和 React Ink TUI，也保留传统交互式 `chat` 命令。

[快速开始](#快速开始) · [核心能力](#核心能力) · [命令参考](#命令参考) · [模型配置](#模型配置) · [开发](#开发)

## 项目状态

- 当前版本：`0.1.0`
- 运行方式：macOS 桌面端 / 本地 CLI / TUI
- 默认入口：TUI
- 默认模型：DeepSeek `deepseek-v4-flash`
- 包管理器：pnpm

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 本地优先 | 在当前工作区内读取规则、文件、Git 状态和项目结构，模型请求由你配置的 provider 承载。 |
| 多模型接入 | 通过 provider profile 与 model alias 管理不同厂商、模型和 endpoint。 |
| 工具协作 | 内置文件、搜索、Git、命令和联网搜索工具，并统一经过权限与会话链路。 |
| 可控执行 | 默认在写文件、编辑文件和执行命令前请求确认；高风险操作始终保留确认边界。 |
| 持续会话 | 将用户消息、助手回复、工具调用、工具结果和错误记录为 JSONL，支持压缩、恢复和审计。 |
| TUI 工作流 | 提供模型切换、推理档位、Plan mode、权限提示、上下文和 usage 面板。 |
| macOS 桌面端 | 提供原生窗口、项目与会话导航、结构化工具过程、实时命令输出、Diff、权限确认和真实中止。 |
| 可扩展 | 支持 Workspace Skill、Plugin、MCP stdio server 和受限只读 Subagent。 |

## 快速开始

### 环境要求

- Node.js LTS
- pnpm 10
- 一个已配置 API key 的模型 provider

### 安装已发布版本

发布到 npm 后，其他用户只需要全局安装一次，之后在任意工作区输入 `biny` 即可进入 TUI：

```bash
npm install --global @biny012/biny
biny
```

也可以使用 pnpm：

```bash
pnpm add --global @biny012/biny
biny
```

### 安装与启动

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny
pnpm install
pnpm dev -- init
```

默认配置使用 DeepSeek。先在当前 shell 设置 API key：

```bash
export DEEPSEEK_API_KEY="你的 DeepSeek API key"
```

然后启动 Biny：

```bash
pnpm dev
```

不带子命令时，Biny 默认进入 TUI。初始化命令是幂等的：如果 `agent.config.json` 或 `.agent/` 已存在，不会覆盖已有配置。

首次运行前可以检查本地环境：

```bash
pnpm dev -- doctor
```

### 本地链接为 `biny` 命令

如果希望在任意工作区使用本地构建版本：

```bash
pnpm build
pnpm link --global

biny
biny doctor
```

`biny` 默认进入 TUI；传统 readline 交互可以使用 `biny chat`。

### 启动 macOS 桌面端

桌面端与 CLI/TUI 读取同一份 `agent.config.json` 和 `.agent/sessions/*.jsonl`。开发模式会打开独立 Electron 窗口：

```bash
pnpm desktop:dev
```

构建可直接运行的未签名 `Biny.app`：

```bash
pnpm desktop:pack
open release/mac-arm64/Biny.app
```

生成 DMG 和 ZIP 分发产物：

```bash
pnpm desktop:dist
```

桌面端实现、IPC 和事件协议见 [`src/desktop/README.md`](src/desktop/README.md)。

维护者发布新版本前需要登录 npm，并在项目根目录执行：

```bash
npm login
npm publish
```

## 常见工作流

### 一次性任务

```bash
biny run "读取 package.json 并解释这个项目的入口"
biny run "搜索 provider 相关配置并总结使用方式"
biny run "运行 pnpm typecheck 并分析错误"
```

### 先规划，再执行

`plan` 只生成计划，不执行写文件、编辑文件或命令工具：

```bash
biny plan "为工具系统增加只读搜索能力"
```

在 TUI 中也可以输入 `/plan` 或按 `Shift+Tab` 切换 Plan mode。Plan mode 允许普通回答和只读工具，禁止有副作用的工具。

### 继续之前的会话

```bash
biny chat --continue
biny chat --session <session-id>
biny sessions
biny resume latest
```

`chat --continue` 和 `chat --session` 会恢复模型可用的历史并继续对话；`resume` 只读打印会话历史，不会切换当前会话。

## 命令参考

| 命令 | 用途 |
| --- | --- |
| `biny` | 默认进入 TUI。 |
| `biny init` | 创建默认配置和 `.agent/` 运行目录，不覆盖已有配置。 |
| `biny doctor` | 检查 Node.js、pnpm、Git、配置文件和 `.agent/` 状态。 |
| `biny run <task>` | 执行一次性 Agent 任务并记录会话事件。 |
| `biny plan <task>` | 生成计划，不执行写入、编辑或命令工具。 |
| `biny tui` | 显式进入 TUI，是默认入口的别名。 |
| `biny chat` | 启动传统交互式会话。支持 `--continue` 和 `--session <id>`。 |
| `biny sessions` | 列出当前工作区的历史会话。 |
| `biny resume [session]` | 只读查看指定会话；不传参数时查看最新会话。 |

## TUI 与 Chat 命令

在 TUI 或 `chat` 中输入 `/` 可以查看命令菜单，并使用上下键选择、Tab 补全和 Enter 确认。

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看命令列表。 |
| `/clear` | 清空当前可见内容。 |
| `/status` | 查看当前模型、推理档位、权限和扩展状态。 |
| `/context` | 查看已加载规则、项目快照、RepoMap 和上下文预算。 |
| `/usage` | 查看 input/output/reasoning/cache token 与成本统计。 |
| `/model [alias] [off\|high\|max]` | 查看或切换模型与推理档位。 |
| `/plan` | 在 TUI 中切换 Plan mode；`chat` 中创建一次性计划。 |
| `/compact [hint]` | 压缩较早的对话历史，减少上下文占用。 |
| `/permissions <mode>` | 查看或切换权限模式。 |
| `/approvals` | `/permissions` 的别名。 |
| `/mcp` | 查看 MCP server 与已注册工具。 |
| `/skills` | 查看已加载的 Workspace Skill。 |
| `/plugins` | 查看已加载的 Plugin。 |
| `/subagent <task>` | 执行一次受限只读 Subagent 任务。 |
| `/review [instructions]` | 使用只读 Subagent 检查当前变更。 |
| `/sessions` | 列出历史会话。 |
| `/resume [session]` | 查看或恢复指定会话。 |
| `/exit`、`/quit` | 退出当前交互。 |

权限模式：

```text
/permissions status
/permissions readonly
/permissions ask
/permissions auto
/permissions full
/permissions reset
```

默认模式是 `ask`。只读工具可以直接执行；写文件、编辑文件、Shell、安装依赖和其他高风险操作会根据当前策略请求确认。即使处于 `full`，Critical 操作仍可能继续请求确认。

## 模型配置

配置文件是工作区根目录下的 `agent.config.json`。推荐只在配置中保存环境变量名，不要把真实 API key 写入仓库、README、测试快照或 session 示例。

API key 的解析顺序为：

1. `providers.<alias>.apiKey`
2. `providers.<alias>.apiKeyEnv`
3. provider 类型对应的默认环境变量

### 默认 DeepSeek 配置

`pnpm dev -- init` 会生成默认配置。最小模型配置如下：

```json
{
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "supportsTools": true,
      "thinking": {
        "efforts": ["high", "max"],
        "defaultEffort": "high"
      }
    }
  },
  "thinking": {
    "enabled": true,
    "effort": "high"
  }
}
```

### 支持的 provider

| `type` | 默认环境变量 | 备注 |
| --- | --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` | 支持 reasoning。 |
| `openai` | `OPENAI_API_KEY` | OpenAI API。 |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic Messages API。 |
| `gemini` | `GEMINI_API_KEY` | Google Gemini OpenAI-compatible endpoint。 |
| `kimi` | `MOONSHOT_API_KEY` | Moonshot AI endpoint。 |
| `qwen` | `DASHSCOPE_API_KEY` | DashScope compatible endpoint。 |
| `ollama` | 不需要 | 默认连接本机 Ollama。 |
| `openai-compatible` | 自定义 | 必须配置 provider `baseUrl`。 |

Provider 负责 endpoint 和凭证，model alias 负责实际模型 ID、输出限制、推理能力和可选价格。TUI 中可以通过 `/model` 切换 alias：

```text
/model deepseek-v4-pro max
/model deepseek-v4-flash off
```

### OpenAI-compatible endpoint

将下面的字段合并到 `agent.config.json`：

```json
{
  "defaultModel": "custom-model",
  "providers": {
    "custom": {
      "type": "openai-compatible",
      "baseUrl": "https://provider.example/v1",
      "apiKeyEnv": "PROVIDER_API_KEY"
    }
  },
  "models": {
    "custom-model": {
      "provider": "custom",
      "model": "provider-model"
    }
  },
  "thinking": {
    "enabled": false,
    "effort": "high"
  }
}
```

通用 endpoint 是否支持 tool calling，取决于上游模型和服务实现。Provider 请求、流式解析和多轮工具循环由 Vercel AI SDK 承载；权限、工具调度、Session 事件和 TUI 状态由 Biny 管理。

## 工作区上下文

Biny 会根据当前任务按需装配工作区上下文，而不是把整个仓库直接塞进 prompt：

- 分层读取根目录和被访问子目录中的 `AGENTS.override.md` / `AGENTS.md` 规则。
- 生成包含工作目录、包管理器、脚本、README、目录轮廓和 Git 状态的项目快照。
- 通过 RepoMap 保留入口、测试、import/export 和符号信息。
- 使用精确的文件搜索、读取和工具结果获取源码细节。
- 默认上下文预算为 24,000 token，超出后自动压缩，或通过 `/compact` 手动压缩。

Biny 不使用 embedding、向量数据库或语义索引。`.agent/memory/` 中的本地 Markdown 记忆使用关键词、路径和主题做确定性匹配，并在写入前执行去重和敏感信息脱敏。

## 工具与权限边界

内置工具包括：

- 文件：`read_file`、`list_files`、`write_file`、`edit_file`
- 搜索：`search_files`、`grep_search`、`web_search`
- Git：`git_status`、`git_diff`
- 命令：`run_command`

所有工具调用都会经过统一的 Tool Registry、Permission Manager、调度器和 Session Recorder。Skill、Plugin、MCP 和 Subagent 注册的工具也复用同一条权限与会话链路。

工作区保护默认忽略 `node_modules`、`.git`、`dist`、`build`、`.env`、`.agent` 等路径；具体策略可以在 `agent.config.json` 的 `workspace.ignore` 和 `permission` 中调整。

## 扩展能力

扩展配置位于 `agent.config.json` 的 `extensions` 字段：

```json
{
  "skills": [".agent/skills"],
  "plugins": [".agent/plugins"],
  "subagent": {
    "enabled": true,
    "maxSteps": 4,
    "maxOutputTokens": 4000
  },
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/workspace"
      ]
    }
  }
}
```

- `.agent/skills/**/*.md` 会作为 Workspace Skill prompt 注入，但不会绕过权限系统。
- `.agent/plugins/**/*.{js,mjs,cjs}` 可以导出 `register(context)` 或 `tools`。
- `mcp` 当前使用 MCP SDK 的 stdio client，server tools 会转换为 Biny tools。
- `delegate_task` 是默认注册的受限只读 Subagent，不能写文件、执行 Shell 或继续委派。
- MCP server 连接失败会在 runtime 启动时显式报错，避免静默降级。

## 会话、恢复与 usage

会话文件保存在：

```text
.agent/sessions/*.jsonl
```

稳定事件类型包括：

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `error`

会话还可以保存 SDK usage、上下文状态和压缩摘要，因此恢复时能够继续使用已有的模型历史、上下文信息和工具调用顺序。脱敏 telemetry 写入 `.agent/telemetry.jsonl`；原始输入和输出默认不记录。配置模型价格后，`/usage` 可以进一步展示成本估算。

## 架构概览

```text
CLI / TUI / Electron Main
   │
   ▼
InteractiveAgentRuntime / CommandRuntime
   │  装配 provider、工具、权限、扩展和 session
   ▼
AgentSession
   ├── ContextMemory / WorkspaceContext / LocalMemory
   ├── ModelManager / Vercel AI SDK
   ├── ToolRegistry / PermissionManager
   └── SessionRecorder / Observability
```

代码边界对应关系：

- `src/cli/`、`src/tui/`：终端命令入口和交互展示。
- `src/desktop/`：Electron Main/Preload 与只负责展示的 React Renderer。
- `src/runtime/`：共享结构化事件适配层，以及组合 provider、工具、权限与 Agent 的 composition root。
- `src/agent/`：有状态 AgentSession、上下文装配和模型消息处理。
- `src/tools/`、`src/permission/`：能力注册、工具执行和权限策略。
- `src/session/`、`src/extensions/`、`src/observability/`：会话、扩展和运行观测。

## 当前限制

- 命令执行仍依赖权限确认，尚未提供更强的 OS 级沙箱和进程隔离。
- 批量文件编辑和复杂修改策略仍在持续完善。
- MCP 当前支持 stdio server，尚未提供远程 HTTP/OAuth server 的管理界面。
- Provider 价格不会自动同步，需要在 model 配置中显式填写后才能计算金额。
- macOS 本地构建默认不签名、不公证；正式分发前需要配置 Apple Developer 签名与 notarization。
- 图片和文件可以拖入或粘贴并保存为工作区附件；当前 Agent 消息核心仍以路径引用传递，尚未将图片转成 provider 原生多模态消息。
- “已安排、插件、站点、拉取请求”等桌面导航入口目前仅展示“暂未实现”，不会伪造结果。

## 开发

安装依赖：

```bash
pnpm install
```

常用验证命令：

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

本地开发入口：

```bash
pnpm dev
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- tui
pnpm desktop:dev
pnpm desktop:pack
```

如果要发布一个 GitHub Release，建议先完成上述验证，再为目标提交创建语义化 Git tag，例如 `v0.1.0`。

## 贡献

欢迎通过 Issue 或 Pull Request 反馈问题、提交改进和补充 provider 配置。提交代码前，请确保：

- 不提交 API key、token、password 或本地敏感配置。
- 通过 `pnpm test`、`pnpm typecheck` 和 `pnpm build`。
- 修改用户可见行为时同步更新 README 和相关测试。
