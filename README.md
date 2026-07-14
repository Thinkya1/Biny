# Biny

Biny 是一个 TypeScript 本地桌面助手，支持 DeepSeek、OpenAI、Claude、Gemini、Kimi、Qwen、Ollama 和通用 OpenAI-compatible API。编码只是它的一个使用场景，其他能力取决于当前运行时已注册的内置工具、MCP、Skill 和 Plugin。

它以状态化 `AgentSession` 为核心，使用无向量化的确定性上下文：分层 `AGENTS.md` 规则、可刷新的项目快照、RepoMap、精确工具结果、会话压缩和本地 Markdown 记忆；同时支持本地文件工具、命令执行确认、执行计划和 `.agent/sessions/*.jsonl` 会话记录。

## 架构

- `src/agent/AgentSession.ts`：一个工作区的一套有状态 Agent，持有 session recorder、权限、工具、模型历史与恢复流程，是 CLI/TUI 的唯一核心入口。
- `src/agent/context/ContextMemory.ts`：持有模型历史、token 预算、自动/手动压缩和 prompt 装配。
- `src/agent/context/WorkspaceContext.ts`：持有分层规则、项目快照、RepoMap 与工具访问后的工作区活动。
- `src/agent/context/LocalMemory.ts`：只处理 `.agent/memory/` 的审计型 Markdown 记忆、脱敏、去重和确定性匹配。
- `src/observability/`：接收 AI SDK usage/telemetry 生命周期，记录脱敏的 `.agent/telemetry.jsonl`，并按模型 pricing 生成成本统计。
- `src/extensions/`：装配工作区 Skill、Plugin、MCP stdio server 和受限只读 Subagent。
- `src/runtime/CommandRuntime.ts`：composition root，只装配配置、provider、工具、权限和 `AgentSession`。
- `src/cli/` 与 `src/tui/`：宿主层，只调用 `AgentSession` 的公开操作，不直接操作 provider、工具、recorder 或 conversation。

## 安装

```bash
pnpm install
```

## 开发模式运行

默认配置使用 DeepSeek。模型密钥按以下顺序解析：`providers.<alias>.apiKey`、`providers.<alias>.apiKeyEnv`、provider 类型的默认环境变量。因此默认配置会读取 `DEEPSEEK_API_KEY`：

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

推荐在当前 shell 设置环境变量：

```bash
export DEEPSEEK_API_KEY="你的 DeepSeek API key"
```

也可以直接放在本地 `agent.config.json` 的 provider 配置中：

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "apiKey": "replace-with-local-secret"
    }
  }
}
```

`apiKey` 会使配置文件成为敏感文件，不应提交、共享或写入 session 示例；`apiKeyEnv` 更适合会被提交的项目配置。

```bash
pnpm dev
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- run "这个项目是做什么的？"
pnpm dev -- plan "给 README 增加用法说明"
pnpm dev -- sessions
pnpm dev -- resume
pnpm dev -- chat
pnpm dev -- chat --continue
pnpm dev -- tui
```

不带子命令运行 `pnpm dev` 时会默认进入 `chat`。

## 链接 `biny` 命令

```bash
pnpm build
pnpm link --global
biny doctor
```

## 示例

```bash
biny run "读取 package.json 并解释"
biny run "修改 src/index.ts，把 hello 改成 hello agent"
biny run "运行 pnpm typecheck 并分析错误"
biny plan "实现一个只读搜索工具"
biny sessions
biny resume
biny chat --session 20260619-153000-abcd1234
biny tui
```

## 命令

### `run`

执行一次任务，并把会话事件写入 `.agent/sessions/*.jsonl`。

```bash
biny run "读取 README.md 并解释"
biny run "运行 pnpm typecheck"
biny run "搜索 \"provider\" 相关配置和用法"
```

`run` 通过 `AgentSession` 的 `ContextMemory` 组装上下文：项目快照包含当前工作目录、包管理器、`package.json` 摘要、`tsconfig.json` 摘要、README 摘要、目录轮廓和 `git status`；RepoMap 只保留路径、入口、测试、import/export 与符号信息。两者都不会把完整源码塞进 prompt，源码应由 `search_files`、`grep_search` 和 `read_file` 按需读取。

### `chat`

启动交互式会话。每轮都会按预算装配上下文；文件写入、编辑或命令执行后，下一轮会刷新项目快照与 RepoMap。

```bash
biny chat
biny chat --continue
biny chat --session <session-id>
```

在 `chat` 的真实终端交互中，输入 `/` 会立即显示可用命令；可以用上下键选择命令，按 Enter 确认，按 Tab 补全。非 TTY 输入中，输入 `/` 并回车会显示命令列表。

可用 slash 命令：

- `/help`：显示命令列表
- `/clear`：清空终端显示
- `/context`：显示已加载规则、token 预算、快照时间、RepoMap、压缩和记忆状态
- `/usage`：显示 SDK 返回的 input/output/reasoning/cache token 与成本；未配置价格时显示 unknown
- `/compact [hint]`：把较早对话压缩为目标、决策、文件、命令结果、验证状态和待办
- `/model [alias] [off|high|max]`：查看或切换模型与思考档位
- `/status`：查看当前模型、推理档位、权限模式和扩展状态
- `/mcp`：查看已配置 MCP server、连接状态和已注册工具
- `/skills`：查看已加载的 workspace skill 文件
- `/plugins`：查看已加载的 plugin 文件
- `/subagent <read-only task>`：执行一次受限只读子任务
- `/review [instructions]`：让只读子任务检查当前变更并返回审查意见
- `/sessions`：列出历史 session
- `/resume [session]`：无参数列出 session；指定 id 时恢复模型可用的历史并继续追加
- `/permissions [status|readonly|ask|auto|full|reset]`：查看或切换当前会话权限模式
- `/approvals`：`/permissions` 的别名
- `/plan <task>`：在普通 chat 中生成一次性计划；TUI 中 `/plan` 切换 Plan mode，后续输入进入只读规划/研究流程
- `/exit`：退出 chat

### `tui`

启动 TUI 终端界面模式。当前 TUI 使用 React Ink 实现，用来替代或增强普通 `chat` 的交互体验。

```bash
biny tui
pnpm dev -- tui
```

当前 TUI 已支持：

- 启动信息面板：固定展示精确模型、思考档位、权限档位和工作目录，查看历史 session 时显示目标 session。
- 消息区域：显示用户输入、assistant 回复、系统状态和错误；长内容可通过详情 overlay 查看。
- 输入区域：输入 prompt 后按 Enter 发送。
- 状态栏：显示 `Idle`、`Thinking`、`Running`、`Waiting Permission`、`Completed`、`Error`；Plan mode 下显示 `Plan mode` 和 `shift+tab to cycle`。
- 工具调用展示：显示工具名、参数摘要、执行状态和结果摘要。
- 权限提示：工具需要确认时显示工具名、动作类型、风险等级、目标路径或命令、reason、修改摘要和 diff。
- 权限设置：`/permissions` 或 `/approvals` 可查看当前模式、session allowlist、项目策略来源和拒绝历史。
- 上下文控制：`/context` 显示实际装配状态，`/compact [hint]` 压缩较早历史。
- 模型切换：`/model` 打开两级选择器，先选择模型，再选择该模型支持的 `Off` / `High` / `Max` 推理档位；reasoning 配置不再限制为 DeepSeek。
- 计划模式：`/plan` 不需要任务参数即可切换模式；`Shift+Tab` 与它使用同一个切换入口。计划模式允许普通回答和已注册的只读工具，禁止写文件、编辑文件、Shell 和其他副作用工具；`/model` 可以在计划模式中切换模型和推理级别。
- 统一命令窗口：`/help`、`/context`、`/usage`、`/status`、`/mcp`、`/skills`、`/plugins`、`/subagent`、`/review`、`/compact`、`/permissions` 和 `/plan` 使用同一套 Codex 风格详情框；`/sessions` 与 `/resume` 使用可搜索、可翻页的选择器；`/model` 使用模型选择 → 推理级别选择两级窗口。所有列表统一使用平直顶/底边框、`❯` 指针、当前/默认标记、编号、描述、分页和 Esc 交互。

权限提示快捷键：

- `Enter` / `y`：允许本次操作。
- `n`：拒绝本次操作。
- `t`：本会话允许当前工具。
- `p`：本会话允许当前路径。
- `s`：本会话允许当前工具和动作类型。
- `r`：切换到 Read Only 并拒绝当前操作。
- `f`：切换到 Full Access 并允许当前操作。Critical 操作后续仍会继续询问。

TUI 使用 `agent.config.json` 中的 provider 和 model alias。切换成功后会先校验并重建 AI SDK `LanguageModel`，再更新 Header 并持久化 `defaultModel` 与 `thinking`；目标 provider 缺少 key 时保持原模型不变。

TUI 内的 `/resume` 行为：

- `/resume`：列出当前项目历史 session。
- `/resume <session id>`：恢复指定 session 的模型历史，并把后续对话继续追加到同一个 `.agent/sessions/*.jsonl` 文件。

### `plan`

CLI `plan` 仍是一次性计划命令，不执行 `write_file`、`edit_file` 或 `run_command`。TUI 的 `/plan` 是可持续切换的 Plan mode，和 CLI 的一次性输出不是同一条运行路径。

```bash
biny plan "为工具系统增加搜索能力"
```

`plan` 输出结构固定为：

- 目标
- 需要查看的文件
- 可能使用的工具
- 执行步骤
- 风险点

`plan` 也会使用同一套上下文装配并写入 `.agent/sessions/*.jsonl`。

### `sessions`

列出 `.agent/sessions` 下的 JSONL 会话文件，显示 session 文件名、首个 `user_message`、事件数量和创建时间。

```bash
biny sessions
```

### `resume`

读取并打印已有会话的历史事件。不传参数时读取最新 session，也可以传 session id 或 `.jsonl` 文件路径。`resume` 当前只用于查看历史，不会切换到旧 session 继续聊天。

```bash
biny resume
biny resume latest
biny resume 20260619-153000-abcd1234
biny resume .agent/sessions/20260619-153000-abcd1234.jsonl
```

## 工具和权限

当前注册的工具：

- `read_file`：读取工作区内文件，可直接执行。
- `list_files`：列出工作区文件，可直接执行。
- `search_files`：在工作区内搜索文本，返回 `path`、`line`、`text`，支持 `maxResults`，可直接执行。
- `grep_search`：按普通子串搜索工作区文件，可直接执行。
- `git_status`：查看 `git status --short`，可直接执行。
- `write_file`：写入工作区内文件，执行前需要用户确认。
- `edit_file`：替换工作区内文件文本，执行前需要用户确认。
- `run_command`：在工作区运行 shell 命令，执行前需要用户确认。
- `web_search`：搜索公网并返回结果标题、链接和摘要；默认无需密钥，可切换到 Brave Search API。

本地文件工具会遵守 workspace ignore 规则，跳过 `node_modules`、`.git`、`dist`、`build`、`.env` 等路径，并限制在当前工作区内执行；`web_search` 只访问配置的搜索服务，不读取或修改本地文件。

公网搜索配置位于 `agent.config.json` 的 `web.search`：

```json
{
  "web": {
    "search": {
      "enabled": true,
      "provider": "duckduckgo",
      "timeoutMs": 10000,
      "maxResults": 5
    }
  }
}
```

默认 `duckduckgo` 不需要 API key。需要稳定配额时可设置 `provider` 为 `brave`，并配置 `apiKeyEnv`（例如 `BRAVE_SEARCH_API_KEY`）；真实 key 只放环境变量，不写进配置文件。

每个工具都有 zod 运行时参数 schema。Agent loop 会在执行工具前统一校验参数；校验失败时不会调用工具实现，并会写入 `tool_result` 和 `error` session 事件，保持会话事件类型稳定。

### 权限模式和确认流程

权限由统一的 `PermissionManager` 判断。项目级策略来自 `agent.config.json` 的 `permission` 字段，示例：

```json
{
  "permission": {
    "mode": "ask",
    "allowTools": ["read_file", "grep_search", "list_files", "search_files", "git_status"],
    "allowPaths": ["src/", "tests/"],
    "denyPaths": [".env", ".ssh/", "node_modules/"],
    "criticalAlwaysAsk": true
  }
}
```

支持的当前会话模式：

- `ask`：读文件、搜索、列目录和 `web_search` 等低风险只读工具直接执行；写入、命令、通过 Shell 发起的网络访问、依赖安装和 Git 状态变更会询问。
- `read-only`：只允许低风险读取、搜索、列表、查看 Git 状态和 `web_search`。
- `auto`：自动允许低风险工具，其他操作询问。
- `full-access`：允许读写和命令执行，但 Critical 操作仍会询问。

TUI 和 chat 中可用：

```text
/permissions status
/permissions readonly
/permissions ask
/permissions auto
/permissions full
/permissions reset
```

`write_file` 在真正写入前会通过 `ToolDisplay` 展示 diff。`edit_file` 和 `run_command` 也有独立的权限提示展示规则。只有用户确认后才会执行写入、编辑或命令。

流程如下：

- PermissionManager 识别 `actionType`、`riskLevel`、目标路径、命令和项目策略
- ToolDisplay 生成权限提示摘要和可选 diff
- 需要用户确认时发出权限请求
- 记录确认结果，拒绝时状态为 `denied`
- 用户确认后执行实际写入
- 记录最终 `tool_result`

对于 `run_command`，`rm`、`chmod`、依赖安装、Git reset/checkout/push、网络访问等会提高风险等级。`sudo`、`curl | sh`、`rm -rf`、`git push --force` 等 Critical 操作即使在 Full Access 下也会继续询问。`web_search` 是单独的低风险只读能力，不需要通过 `run_command` 绕行。

## 会话记录

每条用户消息、助手消息、工具调用、工具结果和错误都会作为一条 JSONL 事件记录到 `.agent/sessions`。

`tool_call` 和 `tool_result` 可选保存 `toolCallId` 与 `sequence`，用于在 `chat --continue`、`chat --session <id>` 和 TUI `/resume` 时按原顺序重建模型历史。独立的 `biny resume` 仍只读打印历史，不会切换当前会话。

`assistant_message` 还会保存 SDK usage、上下文状态和压缩摘要。这样 resume 时会恢复最近一次 provider context token 和已生成的 handoff summary；没有新元数据的旧 session 才回退到本地历史估算。

事件类型统一为：

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `error`

## 上下文与本地记忆

Biny 不使用 embedding、向量库或语义索引。代码任务优先依赖显式路径、RepoMap 符号、最近工具结果和精确的文件搜索/读取结果。

项目规则按目录分层：启动时加载工作区根目录的 `AGENTS.override.md` 或 `AGENTS.md`，访问子目录文件后才加载该目录的规则，总量限制为 32 KiB。`AGENTS.override.md` 在同目录优先。

默认输入预算为 24,000 token。请求发出前仍需要用本地 byte/3 做预估和裁剪；模型返回后，状态栏和 session 使用 AI SDK provider 返回的真实 input token。较早会话超过预算时会自动压缩；`/compact [hint]` 可手动压缩。压缩摘要通过 AI SDK structured output 生成，并作为 `assistant_message.contextState` 持久化，resume 时直接恢复。

成功且足够长的任务会尝试提炼稳定结论到 `.agent/memory/`：`MEMORY.md` 是短索引，主题 Markdown 保存决策、调试结论和工作流。读取按关键词、路径和主题做确定性匹配；写入会跳过短任务、失败/中断任务和重复内容，并脱敏常见 API key、token、secret 与 password 值。

## 模型配置

配置分成几部分：`providers` 保存协议、endpoint 和密钥；`models` 保存可切换的模型 alias、实际模型 ID、reasoning 能力和可选价格；`defaultModel` 指向默认 alias；`thinking` 保存当前默认思考档位。旧版单个 `model` 对象仍可读取，并会在下一次配置写入时转换为新结构。

| provider | 协议 | 默认密钥环境变量 | 默认 endpoint |
| --- | --- | --- | --- |
| `deepseek` | OpenAI-compatible + thinking | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `openai` | OpenAI-compatible | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` |
| `gemini` | OpenAI-compatible | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `kimi` | OpenAI-compatible | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` |
| `qwen` | OpenAI-compatible | `DASHSCOPE_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ollama` | OpenAI-compatible | 不需要 | `http://127.0.0.1:11434/v1` |
| `openai-compatible` | OpenAI-compatible | `providers.<alias>.apiKeyEnv` | 必填 provider `baseUrl` |

示例：

```json
{
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "thinking": {
        "efforts": ["high", "max"],
        "defaultEffort": "high"
      }
    },
    "deepseek-v4-pro": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
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

模型 alias 中存在 `thinking` 表示该模型支持 reasoning 控制。全局 `thinking.enabled` 控制开关，`thinking.effort` 支持 `high` 和 `max`；Biny 会按 provider 映射到 DeepSeek、OpenAI、Anthropic、Qwen 或 Kimi 的原生 SDK 参数，并在工具调用、session 记录和恢复过程中保留 reasoning content。

成本不会写死在代码中，可按模型配置每百万 token 单价。下面数字仅用于说明字段，不代表任何厂商当前价格；只配置部分价格时，`/usage` 会保留 token 统计并把金额标为 unknown：

```json
{
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "pricing": {
        "inputPerMillionTokens": 0,
        "outputPerMillionTokens": 0,
        "cacheReadPerMillionTokens": 0,
        "cacheWritePerMillionTokens": 0
      }
    }
  }
}
```

TUI 输入 `/model` 会打开模型与推理两级选择器；普通 chat 输入 `/model` 会打印模型列表。两个入口都支持直接切换：

```text
/model deepseek-v4-pro max
/model deepseek-v4-flash off
```

```json
{
  "defaultModel": "claude",
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "timeoutMs": 60000
    }
  },
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "your-anthropic-model",
      "maxOutputTokens": 8192
    }
  },
  "thinking": {
    "enabled": false,
    "effort": "high"
  }
}
```

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

Provider 请求、流式解析和多轮 tool loop 由 Vercel AI SDK 统一承载：OpenAI、Anthropic、DeepSeek、Moonshot AI 和 Alibaba 使用对应 provider 包；Gemini、Ollama 与通用 endpoint 使用 `@ai-sdk/openai-compatible`。配置、权限、工具调度、Session 事件和 TUI transcript 仍由 Biny 自己管理。通用兼容 endpoint 是否支持工具调用取决于其上游模型和服务实现。

## 扩展能力

扩展配置位于 `agent.config.json` 的 `extensions`：

```json
{
  "telemetry": {
    "enabled": true,
    "recordInputs": false,
    "recordOutputs": false
  },
  "extensions": {
    "skills": [".agent/skills"],
    "plugins": [".agent/plugins"],
    "subagent": { "enabled": true, "maxSteps": 4, "maxOutputTokens": 4000 },
    "mcp": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
      }
    }
  }
}
```

- `.agent/skills/**/*.md` 会作为 workspace skill prompt 注入，不会绕过权限系统。
- `.agent/plugins/**/*.{js,mjs,cjs}` 可导出 `register(context)` 或 `tools`，注册后的工具仍经过统一 Permission/Session/ToolScheduler 链路。
- `mcp` 使用官方 MCP SDK 的 stdio client，server tools 会转换为 Biny tools；配置的 server 连接失败会在 runtime 启动时显式报错。
- `delegate_task` 是默认注册的只读 Subagent，只能使用 read/search/git inspection 工具，最多执行配置的步数，不可写文件、执行 shell 或继续委派。
