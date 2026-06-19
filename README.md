# Biny

Biny 是一个 TypeScript CLI 本地编码代理。当前版本只使用 `MockProvider`，暂时不会接入 OpenAI、Claude 或其它真实模型。

它支持 ProjectContext、本地文件工具、命令执行确认、执行计划和 `.agent/sessions/*.jsonl` 会话记录。

## 安装

```bash
pnpm install
```

## 开发模式运行

```bash
pnpm dev
pnpm dev -- init
pnpm dev -- doctor
pnpm dev -- run "这个项目是做什么的？"
pnpm dev -- plan "给 README 增加用法说明"
pnpm dev -- sessions
pnpm dev -- resume
pnpm dev -- chat
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
```

## 命令

### `run`

执行一次任务，并把会话事件写入 `.agent/sessions/*.jsonl`。

```bash
biny run "读取 README.md 并解释"
biny run "运行 pnpm typecheck"
biny run "搜索 \"MockProvider\""
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
- `/plan <task>`：只生成计划，不执行写入、编辑或命令
- `/exit`：退出 chat

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
- `write_file`：写入工作区内文件，执行前需要用户确认。
- `edit_file`：替换工作区内文件文本，执行前需要用户确认。
- `run_command`：在工作区运行 shell 命令，执行前需要用户确认。

所有工具都会遵守 workspace ignore 规则，跳过 `node_modules`、`.git`、`dist`、`build`、`.env` 等路径，并限制在当前工作区内执行。

### diff 确认流程

`write_file` 和 `edit_file` 在真正写入前会先展示 diff。只有用户确认后才会写入文件。

流程如下：

- 生成 diff
- 记录包含 diff 的 `tool_call`
- 询问用户确认
- 记录确认结果，拒绝时状态为 `cancelled`
- 用户确认后执行实际写入
- 记录最终 `tool_result`

对于 `run_command`，如果命令包含 `rm`、`sudo`、`chmod`、`git push`、`npm install` 或 `pnpm install`，会被视为敏感命令，必须明确输入 `yes` 才会执行。

## 会话记录

每条用户消息、助手消息、工具调用、工具结果和错误都会作为一条 JSONL 事件记录到 `.agent/sessions`。

事件类型统一为：

- `user_message`
- `assistant_message`
- `tool_call`
- `tool_result`
- `error`

当前版本不需要 API key。真实模型 provider 还没有接入。
