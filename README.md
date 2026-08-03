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
- **可恢复** —— 消息、工具调用和续跑状态都写在本机；进程退出或断网导致回合异常中断后，打开同一 Session 并发送新的用户消息即可继续任务。可恢复的 `blocked / incomplete` 会保留原 Turn 终态；缺少用户信息或需要不安全操作时，必须发送新的用户消息。
- **统一完成门** —— Provider 的 `stop` 只表示一次响应结束。模型停止调用工具后，Completion Gate 会检查 Todo、审批、活跃执行、结构化阻塞、预算和独立验证，再决定 `completed / blocked / incomplete / cancelled`；陈旧 Todo 的 continuation 有无进展上限，后续同动作成功可以覆盖旧失败，验证失败会回到当前 Agent Loop 修复。
- **可扩展** —— Skill、Plugin、MCP server（stdio / http）、具名子代理，以及跨会话的持久记忆。
- **Plan 模式** —— 先出计划，不执行会产生副作用的操作。
- **TUI 模式切换** —— 在 TUI 中按 `Shift+Tab` 可在 Chat 与 Plan 模式之间切换，随后直接输入并发送任务即可。
- **统一交互、按策略限权** —— Desktop、TUI 和 `biny run` 的普通输入都直接进入同一个 AgentSession，不再根据“修改、修复、启动”等自然语言关键词切换执行框架；Chat 和单次任务使用当前权限策略，Plan 只开放只读工具。
- **统一命令语义** —— `/status`、`/usage`、`/memory`、`/subagent` 等命令由 Desktop 与 TUI 共用同一份声明和执行逻辑；`/status` 会同时展示模型、Provider、权限、Session、token 用量和上下文窗口；`biny chat` 是默认 TUI 的兼容别名，不再启动第二套交互循环。
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
pnpm dev -- init                      # 生成 ~/.biny/config.json
export DEEPSEEK_API_KEY="你的 key"
pnpm dev                              # 打开 TUI
```

单次自主任务：`biny run "总结当前项目并指出最重要的风险"`。`biny chat` 与直接运行 `biny` 都打开同一个 TUI。完整命令见 `biny --help`。

## 配置模型和密钥

桌面端在 **设置 → 模型** 里管理连接和默认模型，API key 与 OAuth 凭据由 macOS 系统钥匙串保护。

CLI / TUI / Desktop 共用全局 `~/.biny/config.json`；项目 session、Memory 等运行数据在 `~/.biny/agent/`。设置 `BINY_AGENT_DIR` 后，配置与运行数据都会改从该目录读取，适合测试隔离和便携部署。
项目只在 `<project>/.biny/settings.json` 覆盖运行参数；其中的 `defaultModel` 必须引用全局已有 alias，不能写 `providers`、`models`、API key 或 OAuth 信息。旧项目配置路径只会被 `biny doctor` 报告，不会读取或迁移。

macOS 的 API key 和 OAuth refresh token 存在系统 Keychain，配置 JSON 不保存凭据；其他平台请使用环境变量。全局配置示例（**只写环境变量名，别把真实 key 写进配置文件**）：

```json
{
  "defaultModel": "coder",
  "providers": {
    "deepseek": { "type": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "models": {
    "coder": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "capabilities": { "tools": true, "reasoning": true, "reasoningStream": true, "streaming": true }
    }
  }
}
```

模型的 `capabilities`、`contextWindow`、`maxInputTokens`、`maxOutputTokens` 和 `limits` 都是可选元数据；未填写的字段由 ModelRegistry 与 ProviderRuntime 按内置模型、插件目录、动态目录和 Provider 默认值补齐。已知 DeepSeek V4 Flash/Pro 未填写 `contextWindow` 时使用官方 1M 窗口；只有在配置中显式填写时才覆盖模型元数据。模型切换不会把自动补齐的限制写回 `config.json`。`maxInputTokens` 是 Provider 的协议硬上限，不是最终可发送预算；上下文实际输入预算还会扣除输出、reasoning、工具 schema、system prompt 和协议安全预留。模型切换后会重新计算，不能把 `contextWindow` 直接当作可发送的输入上限。

自动压缩默认开启。Biny 会先组装当前用户消息、系统规则、项目 `AGENTS.md`、RepoMap、项目快照、记忆和完整历史的候选成本，再结合 Provider 上一轮返回的真实 input usage 判断是否压缩；不再用固定的“历史占窗口 45%”阈值。未配置时，压缩安全余量和最近历史保留量会按当前模型输入预算缩放，并分别以 16,384、20,000 token 为上限；摘要最多输出 4,096 token。需要固定边界时可配置：

```json
{
  "context": {
    "maxTurnToolResultBytes": 131072,
    "compaction": {
      "enabled": true,
      "reserveTokens": 16384,
      "keepRecentTokens": 20000,
      "maxSummaryTokens": 4096
    }
  }
}
```

省略 `reserveTokens`、`keepRecentTokens` 即恢复动态值。一次回合累计超过 `maxTurnToolResultBytes` 的工具结果会写入 `<project>/.biny/tool-results/`，模型上下文只保留可由 `read_tool_result` 重新读取的引用；长回合继续增长时，较早的普通工具结果会缩成小预览，最近两个结果保持原样。

`type` 内置支持 `deepseek`、`openai`、`anthropic`、`gemini`、`kimi`、`qwen`、`xai`、`mistral`、`groq`、`openrouter`、`cerebras`、`togetherai`、`fireworks-ai`、`nvidia`、`siliconflow`、`zai`、`ollama` 等；自建网关可用 `openai-compatible` 并补上 `baseUrl`。Provider 和 `apiBackend` ID 也是插件扩展点，不再受内置枚举限制。单个模型还可以用 `apiBackend`、`baseUrl`、`headers`、`compatibility` 覆盖 provider 默认值，但不能写 API key。配置文件按 `0600` 保存，`biny doctor` 会检测旧的工作区/桌面配置并给出迁移提示，但不会自动复制旧配置或凭据。

模型档位使用模型级 `thinkingLevelMap`，值是 provider 接受的参数名；缺省或 `null` 表示该档位不可用。例如：

```json
{
  "models": {
    "deepseek-v4-pro": {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "thinkingLevelMap": {
        "off": "none",
        "high": "high",
        "max": "max"
      }
    },
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "thinkingLevelMap": {
        "off": "none",
        "high": "high",
        "max": "max"
      }
    }
  }
}
```

项目覆盖示例：

```json
{
  "defaultModel": "coder",
  "thinking": { "enabled": false },
  "agent": {
    "softStepLimit": 16,
    "hardStepLimit": 64,
    "maxToolCalls": 256,
    "maxCompletionContinuations": 3,
    "maxRepeatedActions": 3
  },
  "permission": { "mode": "read-only" },
  "context": { "memory": { "maxRecalled": 1 } },
  "sandbox": { "mode": "workspace-write" }
}
```

Agent 预算默认软限制为 32 个 provider step、硬限制为 96 个 step。达到软限制只会注入收敛提醒；达到硬限制返回可恢复的 `incomplete`，绝不会发布 `run.completed`。Provider 请求重试统一由 `providers.<alias>.retry` 控制，`finishReason` 仍会记录用于诊断，但实际工具调用才决定 Loop 是否继续。

### Agent Runtime

CLI、TUI 和 Desktop 的默认任务入口使用 Biny 自己的 native Agent Runtime：模型请求通过独立 API Adapter 归一化为统一的 `ModelStreamEvent`，文本、reasoning、tool call、usage、错误和停止原因沿同一 Agent Loop 转发。Agent Loop 只处理统一消息，不区分底层的 Anthropic `tool_use`、Responses `function_call`、Google `functionCall` 或 Chat Completions `tool_calls`。内置 Adapter 包括 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI；插件可注册新的 API ID、Adapter、Provider、OAuth 刷新处理器和离线/动态模型目录。流式 Adapter 只有收到协议终止事件或明确的 finish reason 才发布 `finish`；连接提前结束会作为 Provider 错误记录，不会把半段输出标成正常完成。模型元数据按字段合并：用户模型配置优先，其次是已注册的内置/插件基线，再由实时或缓存 `/models` 目录补齐缺失字段，最后才使用 Provider 默认值和保守默认值；同 ID 的插件注册仍可覆盖内置基线，这是现有扩展点。实时目录只补充展示名、能力和 token 限制，返回的 `baseUrl`、headers、API 类型及兼容性字段不会进入请求配置；模型级传输覆盖只接受用户配置或本地注册基线。实时目录会跨进程缓存，缓存保留 context、输入/输出限制、reasoning、工具和流式能力；重新启动或临时断网时仍能恢复上次成功取得的模型，在线刷新使用 ETag / Last-Modified 避免重复传输完整目录。模型配置只接受当前的 `defaultModel`、`providers`、`models` 结构，旧格式会直接拒绝并提示手工更新。

插件注册函数通过 `BinyPluginContext` 提供：`registerProvider()`、`registerModels()`、`registerApiAdapter()`、`registerCredentialHandler()` 和 `registerTool()`。插件会在默认模型创建前加载，因此插件 Provider 可以直接作为 `defaultModel` 使用。API Adapter 接收统一的 Message/Tool 上下文并输出统一事件；普通调用走 `streamSimple()`，由 Provider Runtime 将 `off / low / high / max` 等档位转换成当前模型参数。显式声明 reasoning 档位的通用 OpenAI-compatible 模型使用标准 `reasoning_effort` 参数；未声明 reasoning 能力的未知模型仍不会猜测高级参数。

任务运行中仍可继续输入：同一 Session 的普通发送会进入 follow-up 队列，当前任务准备结束时继续处理；TUI 的 `Ctrl-S` 和 Desktop 的 `Command/Ctrl+Enter` 会把输入作为 steer，在当前模型步骤和工具批次结束后优先注入。每个模型步骤前都会重新读取配置修订、模型设置、动态工具和扩展提示；Provider 拒绝过长上下文时，Runtime 会在完整工具批次边界压缩历史并进行有界恢复。

压缩会写入带 `firstKeptMessageId` 的 `context_checkpoint` Session 事件。恢复 Session 时，该 checkpoint 是模型上下文的真值：边界之前的消息不会再次送给模型，但原始 JSONL 与消息树仍保留它们用于审计和分叉。后续压缩会用“上一份摘要 + 新增对话”增量更新 checkpoint，并累计读写文件清单；一个超长回合可以在安全的 assistant 边界切分，但不会拆开 tool call 与 tool result。新 Session 会直接保存完整的 assistant/tool-result `AgentMessage`，canonical 消息节点带稳定 ID 和父节点引用；旧的扁平审计事件继续保留用于界面投影，并可向后兼容回放。

当前没有单独的 Durable Task 执行框架。普通问答、代码修改、启动项目和多步工具任务都进入同一个 Agent Loop；验证器只根据文件变化、结构化检查、受管进程等运行事实启动。验证命令的 stdout/stderr 在模型上下文中最多保留 4000 字符摘要，完整结果通过对应的审计 `tool_call` 记录在 Session JSONL 中。

TUI 中输入 `/model` 后先选择模型；该命令只读取全局配置和已缓存的模型目录，不同步等待远程请求。只有模型声明了可调的 reasoning effort，才会继续打开对应的档位选择器，也可以直接用 `provider/model-id` 引用已配置或已缓存的模型。当前 DeepSeek V4 Flash/Pro 使用 `high`、`max` 两档，Flash 不再因为 alias 或动态目录缺字段而丢失 reasoning；Kimi K3 使用 `low`、`high`、`max`，且不能关闭思考。OpenAI、Anthropic、Gemini、DeepSeek、Qwen、Kimi 的 thinking/effort 映射由 ProviderRuntime 统一完成，Adapter 只解析协议和 reasoning 流。未知模型不猜测高级参数；只有目录或用户元数据明确声明支持时才启用。这里的名称是模型/Provider 支持的配置选项，不代表跨模型可比较的真实推理程度。

联网搜索启用后默认走 AnySearch（`ANYSEARCH_API_KEY`，也可用匿名额度），另支持 Google、DuckDuckGo、Brave 和 Tavily，在 `web.search` 里切换。桌面端的 **设置 → 联网搜索** 提供独立浏览器和 Cookie-Editor JSON 导入/导出；在其中登录后，Google 搜索与 `web_fetch` 会按域名、路径和 HTTPS 规则使用对应 Cookie。

为避免普通聊天在没有明确意图时自动扩大能力面，联网搜索/抓取与共享 Cookie、子代理、持久记忆、自动诊断和本地 telemetry 默认关闭；需要时在全局配置或 Desktop 设置中显式开启。Skill 仍会扫描已配置目录，MCP 只连接明确启用的 server，回合前 Git checkpoint 保持开启。

Skill 按 Agent Skills 格式使用带 YAML frontmatter 的 `SKILL.md`：新根回合只把 `name`、`description` 和路径放入初始清单，清单总长度最多 8,000 字符；命中后由 `invoke_skill` 读取完整正文，再由 `read_skill_resource` 按需读取 `references/`、`scripts/`、`assets/` 中的文本资源。`$skill-name` 表示显式调用；同名 Skill 不合并，模型调用时用清单中的路径消歧。新增 Skill、修改名称或描述会在下一个根回合自动发现。超大正文或资源会明确报错，不会静默截断。

全局配置中的 provider/model、上下文预算、步数与成本上限、子代理、Skill / MCP / Plugin、诊断钩子等设置，schema 见 [`src/config/schema.ts`](./src/config/schema.ts)；项目覆盖只允许运行参数。

## 数据存在哪

项目会话脱离工作区存放，桌面端和 CLI 按项目路径哈希访问同一份历史：

```text
~/.biny/agent/sessions/<project-path-hash>/<YYYY>/<MM>/<DD>/*.jsonl 问答历史
~/.biny/agent/memory/<project-path-hash>/   项目长期记忆
~/.biny/agent/models-store.json             Provider 动态模型目录缓存
<project>/.biny/attachments/                图片、音频等会话附件
<project>/.biny/tool-results/               超出回合预算的工具结果归档
<project>/.biny/                            settings、runs、turns、todos、logs 等
```

全局模型配置在 `~/.biny/config.json`；项目 session、项目 Memory 和 Provider 动态模型目录缓存位于 `~/.biny/agent/`（可由 `BINY_AGENT_DIR` 覆盖）。Session 与 Memory 分别按项目隔离在 `sessions/<project-path-hash>/<YYYY>/<MM>/<DD>/`、`memory/<project-path-hash>/`，模型目录缓存统一保存在 `models-store.json`。新建 session 会按本地日期写入年/月/日目录，旧的平铺 `sessions/<project-path-hash>/*.jsonl` 仍可读取，不会在运行中的 session 被静默移动。该缓存按 `0600` 原子写入，只保存模型元数据、检查时间和 HTTP 校验信息，不保存 API key、OAuth token、Cookie 或鉴权请求头；文件损坏时会忽略旧内容并在下次成功刷新时重建。全局 Skill 默认从 `~/.agents/skills/`、兼容目录 `~/.biny/skills/` 和管理员目录 `/etc/codex/skills/` 发现，named agent 仍位于 `~/.biny/agents/`。桌面端的项目列表和 UI 状态在 `~/Library/Application Support/Biny/workspaces/default/`，附件、run 等其余项目数据暂时仍在项目 `.biny/`。旧的 `<project>/.biny/sessions/` 和 `<project>/.biny/memory/` 不再读取或复制。

项目级 Skill 会从当前工作目录逐层扫描到 Git 仓库根目录下的 `.agents/skills/`，并兼容 `<project>/.biny/skills/`；named agent 仍从 `<project>/.biny/agents/` 覆盖全局同名定义。旧的单数目录 `<project>/.agent/` 不再扫描或自动迁移。

同一个 Session 同一时刻只能由一个运行时执行，另一个会返回占用提示；不同 Session 可以并行。

新建 Session 使用 UUIDv7 作为文件名（例如 `019...jsonl`）：UUID 高位包含 UTC 毫秒时间戳，因此按文件名字典序可以按创建时间排序；同一毫秒内用随机位避免冲突。已有的旧格式 session ID 仍可按完整 ID 或唯一前缀恢复。`biny sessions`、TUI 会话选择器和 Desktop 会话列表按最近更新时间从新到旧展示，`resume latest` 仍按文件修改时间选择最近会话。

工具执行中断时，Session JSONL 会分别记录工具调用、执行状态和工具结果。已经开始但无法确认最终副作用的调用会恢复为 `unknown`，不会被展示为成功，也不会由 Biny 自动重试；模型会看到恢复结果并自行决定下一步。尚未开始执行的调用会从模型恢复上下文中移除并标记为 skipped。用户不需要也不能通过 `/continue` 恢复工具回合：`/resume` 只选择并打开最近的 Session，发送普通新消息即可继续当前上下文；内部断点续跑只用于进程崩溃后的安全恢复。

## 当前边界

- 本地构建不签名、不公证，公开 Release 需要配置 macOS signing / notarization secrets；
- 没有语音输入和实时语音对话；已有 MP3/WAV 音频可发送给明确声明 audio 能力的 OpenAI-compatible / Responses 模型，Anthropic Messages 不接收音频；
- 部分桌面端入口仍在开发中，界面上会明确标注。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
```

欢迎通过 Issue 或 PR 反馈。请勿提交 API key、token 或其他本地敏感配置。

桌面端实现与 IPC 协议见 [src/desktop/README.md](./src/desktop/README.md)。
