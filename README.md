# Biny

> 你的项目，你的 Agent。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区里运行：连接你自己的模型服务，在权限确认下读写文件、搜索代码、执行命令；会话保存在本机，随时可以恢复，而不是被锁在某个云端产品里。

> [!IMPORTANT]
> Biny 仍在持续开发中，建议先在副本或非关键项目中体验。

## 功能

- **两种入口** —— macOS 桌面端管理项目、会话、模型和权限，并带一个可停靠的内嵌终端；终端里用 `biny` 打开 TUI，或 `biny run "任务"` 执行单次任务。两边共用同一份会话数据。
- **模型不设限** —— DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama，以及任意 OpenAI-compatible / Anthropic-compatible 网关。支持推理档位、流式输出和用量统计。
- **完整工具集** —— 文件读写与补丁、代码搜索、Git、Shell、长期进程管理、联网搜索与网页抓取、跨回合待办清单。
- **执行可控** —— 读写和命令执行走统一权限策略，高风险操作必须完整输入 `yes`；可选的 macOS 沙箱把 `run_command` 的写入限制在工作区内。
- **可回退** —— 每个回合首次改动工作区前自动建快照，`/undo` 回退。快照挂在独立 ref 上，不碰你的暂存区、分支和 `git log`。
- **可恢复** —— 消息、工具调用、验收证据和续跑状态都写在本机；被打断后 `/continue` 从最后一个完成的步继续，不用重跑。
- **可扩展** —— Skill、Plugin、MCP server（stdio / http）、具名子代理，以及跨会话的持久记忆。
- **Plan 模式** —— 先出计划，不执行会产生副作用的操作。

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
pnpm dev -- init                      # 生成 agent.config.json
export DEEPSEEK_API_KEY="你的 key"
pnpm dev                              # 打开 TUI
```

单次任务：`biny run "总结当前项目并指出最重要的风险"`。完整命令见 `biny --help`。

## 配置模型和密钥

桌面端在 **设置 → 模型** 里管理连接和默认模型，API key 与 OAuth 凭据由 macOS 系统钥匙串保护。

CLI / TUI 读项目根目录的 `agent.config.json`。**只写环境变量名，别把真实 key 写进配置文件**：

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

`type` 可以是 `deepseek`、`openai`、`anthropic`、`gemini`、`kimi`、`qwen`、`ollama`、`openai-compatible` 等；自建网关用 `openai-compatible` 并补上 `baseUrl`。配置文件按 `0600` 保存，`biny doctor` 会提示 inline key 风险（不会打印 key 内容）。

联网搜索默认走 AnySearch（`ANYSEARCH_API_KEY`，也可用匿名额度），另支持 DuckDuckGo、Brave 和 Tavily，在 `web.search` 里切换。

更细的调优项——上下文预算、步数与成本上限、子代理、Skill / MCP / Plugin、诊断钩子、沙箱——都在 `agent.config.json` 里，schema 见 [`src/config/schema.ts`](./src/config/schema.ts)。

## 数据存在哪

会话和运行时数据写在项目里，桌面端和 CLI 共用：

```text
<project>/.agent/sessions/   问答历史
<project>/.agent/            runs、tasks、logs、memory 等
```

桌面端的全局数据（模型配置、凭据、项目列表、附件）在 `~/Library/Application Support/Biny/workspaces/default/`。

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
