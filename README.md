# Biny-Agent。

> 一个想法、半句话、一段粘贴——剩下交给 Biny。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区里运行：连接你自己的模型服务，在权限确认下读写文件、搜索代码、执行命令；会话保存在本机，随时可以恢复，而不是被锁在某个云端产品里。

> [!IMPORTANT]
> 利用空余时间持续开发中，如果有没有注意到的功能以及 bug 欢迎提交 issue。

## 功能

- **两种入口** —— macOS 桌面端管理项目、会话、模型和权限，并带一个可停靠的内嵌终端；终端里用 `biny` 打开 TUI，或 `biny run "任务"` 执行单次任务。两边共用同一份会话数据。
- **模型不设限** —— DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama，以及任意 OpenAI-compatible / Anthropic-compatible 网关。支持推理档位、流式输出和用量统计。
- **完整工具集** —— 文件读写与补丁、代码搜索、Git、Shell、长期进程管理、联网搜索与网页抓取、跨回合待办清单。
- **执行可控** —— 读写和命令执行走统一权限策略，高风险操作必须完整输入 `yes`；可选的 macOS 沙箱把 `run_command` 的写入限制在工作区内。
- **可回退** —— 每个回合首次改动工作区前自动建快照，`/undo` 回退。快照挂在独立 ref 上，不碰你的暂存区、分支和 `git log`。
- **可恢复** —— 消息、工具调用、验收证据和续跑状态都写在本机；被打断后 `/continue` 从最后一个完成的步继续，不用重跑。
- **可扩展** —— Skill、Plugin、MCP server（stdio / http）、具名子代理，以及跨会话的持久记忆。
- **Plan 模式** —— 先出计划，不执行会产生副作用的操作。
- **统一交互、按策略限权** —— Desktop/TUI 的每条输入都直接进入同一个 AgentSession：Chat 使用当前权限策略，Plan 只开放只读工具；只有显式的 `biny run` 使用 durable 任务契约、独立验证和续跑，不猜测一条普通输入是否“足够复杂”。
- **统一命令语义** —— `/status`、`/context`、`/usage`、`/memory`、`/subagent`、`/continue` 等命令由 Desktop 与 TUI 共用同一份声明和执行逻辑；`biny chat` 是默认 TUI 的兼容别名，不再启动第二套交互循环。
- **图片附件** —— Desktop 可直接粘贴/拖入图片，TUI 用 `Ctrl+V`（Windows 为 `Alt+V`）粘贴系统剪贴板图片；附件保存在项目 `.biny/attachments`，会话只记录引用。输入会先写入会话；模型未声明 `vision` 时会记录明确错误，不会静默丢弃图片。

## 快速开始

### 桌面端

从 [Releases](https://github.com/Thinkya1/Biny/releases) 下载 DMG（Apple 芯片选 `arm64`，Intel 选 `x64`），拖进「应用程序」即可，不需要装 Node.js。

打开后进入 **设置 → 模型** 连接一个模型并测试连接，然后打开项目开始任务。

> 本地构建不会自动签名。若 macOS 提示无法验证开发者，请使用 Release 里的签名产物。

### 终端

需要 Node.js LTS 和 pnpm 10：

```bash
git clone https://github.com/Thinkya1/Biny.git
cd Biny && pnpm install
pnpm dev -- init                      # 生成 ~/.biny/agent/agent.config.json
export DEEPSEEK_API_KEY="你的 key"
pnpm dev                              # 打开 TUI
```

单次自主任务：`biny run "总结当前项目并指出最重要的风险"`。`biny chat` 与直接运行 `biny` 都打开同一个 TUI。完整命令见 `biny --help`。

## 配置模型和密钥

桌面端在 **设置 → 模型** 里管理连接和默认模型，API key 与 OAuth 凭据由 macOS 系统钥匙串保护。

CLI / TUI / Desktop 共用全局 `~/.biny/agent/agent.config.json` 和项目会话目录。也可以用 `BINY_AGENT_DIR` 指定全局目录。
项目只在 `<project>/.biny/settings.json` 覆盖运行参数；其中的 `defaultModel` 必须引用全局已有 alias，不能写 `providers`、`models`、API key 或 OAuth 信息。

macOS 的 API key 和 OAuth refresh token 存在系统 Keychain，配置 JSON 不保存凭据；其他平台请使用环境变量。全局配置示例（**只写环境变量名，别把真实 key 写进配置文件**）：

```json
{
  "defaultModel": "coder",
  "providers": {
    "deepseek": { "type": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "models": {
    "coder": { "provider": "deepseek", "model": "deepseek-chat" }
  }
}
```

`type` 可以是 `deepseek`、`openai`、`anthropic`、`gemini`、`kimi`、`qwen`、`ollama`、`openai-compatible` 等；自建网关用 `openai-compatible` 并补上 `baseUrl`。单个模型还可以用 `apiBackend`、`baseUrl`、`headers`、`compatibility` 覆盖 provider 默认值，但不能写 API key。配置文件按 `0600` 保存，`biny doctor` 会检测旧的工作区/桌面配置并给出迁移提示，但不会自动复制旧配置或凭据。

模型档位使用模型级 `thinkingLevelMap`，值是 provider 接受的参数名；缺省或 `null` 表示该档位不可用。例如：

```json
{
  "models": {
    "deepseek-v4-pro": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "thinkingLevelMap": {
        "off": "none",
        "low": "low",
        "medium": "medium",
        "high": "high"
      }
    },
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "thinkingLevelMap": { "off": "none" }
    }
  }
}
```

项目覆盖示例：

```json
{
  "defaultModel": "coder",
  "thinking": { "enabled": false },
  "agent": { "maxSteps": 16 },
  "permission": { "mode": "read-only" },
  "context": { "memory": { "maxRecalled": 1 } },
  "sandbox": { "mode": "workspace-write" }
}
```

TUI 中输入 `/model` 后先选择模型；只有该模型声明了可调的 reasoning effort，才会继续打开对应的档位选择器。列表不会把所有模型强行显示成同一套档位：例如 DeepSeek V4 Pro 使用自身声明的三档 `low`、`medium`、`high`，DeepSeek V4 Flash 不显示思考档位。这里的名称是模型/Provider 支持的配置选项，不代表跨模型可比较的真实推理程度。模型目录刷新后，实时模型会进入同一注册表，也可以用 `provider/model-id` 引用；选中的实时模型元数据会写入全局模型配置。

联网搜索启用后默认走 AnySearch（`ANYSEARCH_API_KEY`，也可用匿名额度），另支持 Google、DuckDuckGo、Brave 和 Tavily，在 `web.search` 里切换。桌面端的 **设置 → 联网搜索** 提供独立浏览器和 Cookie-Editor JSON 导入/导出；在其中登录后，Google 搜索与 `web_fetch` 会按域名、路径和 HTTPS 规则使用对应 Cookie。

为避免普通聊天在没有明确意图时自动扩大能力面，联网搜索/抓取与共享 Cookie、子代理、持久记忆、自动诊断和本地 telemetry 默认关闭；需要时在全局配置或 Desktop 设置中显式开启。Skill 仍会扫描已配置目录，MCP 只连接明确启用的 server，回合前 Git checkpoint 保持开启。

全局配置中的 provider/model、上下文预算、步数与成本上限、子代理、Skill / MCP / Plugin、诊断钩子等设置，schema 见 [`src/config/schema.ts`](./src/config/schema.ts)；项目覆盖只允许运行参数。

## 数据存在哪

项目会话脱离工作区存放，桌面端和 CLI 按项目路径哈希访问同一份历史：

```text
~/.biny/agent/sessions/<project-path-hash>/ 问答历史
~/.biny/agent/memory/<project-path-hash>/   项目长期记忆
<project>/.biny/attachments/                图片、音频等会话附件
<project>/.biny/                            settings、runs、tasks、logs 等
```

全局模型配置、项目 session 和项目 Memory 都在 `~/.biny/agent/`（可由 `BINY_AGENT_DIR` 覆盖）；Session 与 Memory 分别按项目隔离在 `sessions/<project-path-hash>/`、`memory/<project-path-hash>/`。全局 Skill / named agent 仍分别在 `~/.biny/skills/`、`~/.biny/agents/`。桌面端的项目列表和 UI 状态在 `~/Library/Application Support/Biny/workspaces/default/`，附件、run 等其余项目数据暂时仍在项目 `.biny/`。旧的 `<project>/.biny/sessions/` 和 `<project>/.biny/memory/` 不再读取或复制。

项目级 Skill 和 named agent 分别从 `<project>/.biny/skills/`、`<project>/.biny/agents/` 覆盖全局同名定义。旧 `<project>/.agent/` 不再扫描或自动迁移。

同一个 Session 同一时刻只能由一个运行时执行，另一个会返回占用提示；不同 Session 可以并行。

## 当前边界

- 本地构建不签名、不公证，公开 Release 需要配置 macOS signing / notarization secrets；
- 没有语音输入和实时语音对话，只支持把已有音频附件作为模型输入；
- 部分桌面端入口仍在开发中，界面上会明确标注。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
```

欢迎通过 Issue 或 PR 反馈。请勿提交 API key、token 或其他本地敏感配置。

桌面端实现与 IPC 协议见 [src/desktop/README.md](./src/desktop/README.md)。
