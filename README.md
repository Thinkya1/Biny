# Biny

Biny 是一个 TypeScript CLI 本地编码代理，当前支持 DeepSeek 和通用 OpenAI-compatible API。

它支持 ProjectContext、本地文件工具、命令执行确认、执行计划和 `.agent/sessions/*.jsonl` 会话记录。

## 安装

```bash
pnpm install
```

## 开发模式运行

默认配置使用 DeepSeek；运行时会读取 `config.model.apiKeyEnv` 指向的环境变量，因此默认需要 `DEEPSEEK_API_KEY`：

```json
{
  "model": {
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  }
}
```

API key 不要写入仓库文件。运行前在当前 shell 设置环境变量：

```bash
export DEEPSEEK_API_KEY="你的 DeepSeek API key"
```

```bash
pnpm dev
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- run "这个项目是做什么的？"
pnpm dev -- plan "给 README 增加用法说明"
pnpm dev -- sessions
pnpm dev -- resume
pnpm dev -- chat
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

`run` 启动时会收集 ProjectContext，包含当前工作目录、包管理器、`package.json` 摘要、`tsconfig.json` 摘要、README 摘要、`src` 目录树和 `git status`。ProjectContext 只读取摘要和有限目录树，不会读取整个项目。

### `chat`

启动交互式会话。`chat` 启动时同样会收集一次 ProjectContext，并在同一个 session 中记录后续消息和工具事件。

```bash
biny chat
```

在 `chat` 的真实终端交互中，输入 `/` 会立即显示可用命令；可以用上下键选择命令，按 Enter 确认，按 Tab 补全。非 TTY 输入中，输入 `/` 并回车会显示命令列表。

可用 slash 命令：

- `/help`：显示命令列表
- `/clear`：清空终端显示
- `/context`：打印当前 ProjectContext 摘要
- `/sessions`：列出历史 session
- `/resume [session]`：查看指定 session，不传参数时查看 latest
- `/permissions [status|readonly|ask|auto|full|reset]`：查看或切换当前会话权限模式
- `/approvals`：`/permissions` 的别名
- `/plan <task>`：只生成计划，不执行写入、编辑或命令
- `/exit`：退出 chat

### `tui`

启动 TUI 终端界面模式。当前 TUI 使用 React Ink 实现，用来替代或增强普通 `chat` 的交互体验。

```bash
biny tui
pnpm dev -- tui
```

当前 TUI 已支持：

- Header：显示 BinyAgent、TUI 模式、当前工作目录、当前 provider 和 session id。
- 消息区域：显示用户输入、assistant 回复、系统状态和错误；支持 `PageUp` / `PageDown` 浏览历史，`End` 回到最新消息。
- 输入区域：输入 prompt 后按 Enter 发送。
- 状态栏：显示 `Idle`、`Thinking`、`Running`、`Waiting Permission`、`Completed`、`Error`。
- 工具调用展示：显示工具名、参数摘要、执行状态和结果摘要。
- 权限提示：工具需要确认时显示工具名、动作类型、风险等级、目标路径或命令、reason、修改摘要和 diff。
- 权限设置：`/permissions` 或 `/approvals` 可查看当前模式、session allowlist、项目策略来源和拒绝历史。

权限提示快捷键：

- `Enter` / `y`：允许本次操作。
- `n`：拒绝本次操作。
- `t`：本会话允许当前工具。
- `p`：本会话允许当前路径。
- `s`：本会话允许当前工具和动作类型。
- `r`：切换到 Read Only 并拒绝当前操作。
- `f`：切换到 Full Access 并允许当前操作。Critical 操作后续仍会继续询问。

TUI 使用 `agent.config.json` 中配置的 provider。当前默认配置为 DeepSeek，也可以切换到其它 OpenAI-compatible 接口；对应 API key 仍然必须从环境变量读取。

TUI 内的 `/resume` 行为：

- `/resume`：列出当前项目历史 session。
- `/resume <session id>`：恢复指定 session，并把后续对话继续追加到同一个 `.agent/sessions/*.jsonl` 文件。

### `plan`

只生成执行计划，不执行 `write_file`、`edit_file` 或 `run_command`。

```bash
biny plan "为工具系统增加搜索能力"
```

`plan` 输出结构固定为：

- 目标
- 需要查看的文件
- 可能使用的工具
- 执行步骤
- 风险点

`plan` 也会写入 `.agent/sessions/*.jsonl`。

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

所有工具都会遵守 workspace ignore 规则，跳过 `node_modules`、`.git`、`dist`、`build`、`.env` 等路径，并限制在当前工作区内执行。

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

- `ask`：读文件、搜索、列目录等低风险只读工具直接执行；写入、命令、网络、依赖安装和 Git 状态变更会询问。
- `read-only`：只允许低风险读取、搜索、列表和查看 Git 状态。
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

对于 `run_command`，`rm`、`chmod`、依赖安装、Git reset/checkout/push、网络访问等会提高风险等级。`sudo`、`curl | sh`、`rm -rf`、`git push --force` 等 Critical 操作即使在 Full Access 下也会继续询问。

## 会话记录

每条用户消息、助手消息、工具调用、工具结果和错误都会作为一条 JSONL 事件记录到 `.agent/sessions`。

事件类型统一为：

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `error`

## 模型配置

Biny 当前支持：

- `deepseek`：DeepSeek API，默认读取 `DEEPSEEK_API_KEY`。
- `openai-compatible`：通用 OpenAI-compatible 接口，可配置 `baseUrl`、`model` 和 `apiKeyEnv`。

所有 provider 的密钥都只从环境变量读取，不写入代码、配置示例或会话数据。

DeepSeek 使用官方 OpenAI-compatible Chat Completions 格式，默认 `baseUrl` 为 `https://api.deepseek.com`，默认模型为 `deepseek-chat`。
