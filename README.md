# Biny

> 你的项目，你的 Agent。

**Biny 是一个本地优先的 AI Agent，可在 macOS 桌面端或终端中完成编码、研究和文件处理。**

它直接在你的工作区中运行。你可以连接自己的模型服务，在权限确认下读取文件、搜索代码、执行命令和修改项目；会话可以在本机恢复，而不是被锁定在某个云端产品里。

> [!IMPORTANT]
> Biny 正在持续开发中。桌面端、CLI 和模型接入仍会改进，建议先在副本或非关键项目中体验。

## 为什么是 Biny

- **本地优先**：项目文件留在你的电脑上，模型由你自行选择和配置。
- **模型不设限**：支持 DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama 及 OpenAI-compatible 服务。
- **执行可控**：读取、写入、编辑和命令执行都经过权限确认；高风险操作不会静默执行。
- **会话可恢复**：消息、工具调用和运行状态保存在本机，任务可以继续而不必从头描述。

## 使用方式

| 入口 | 适合什么 | 说明 |
| --- | --- | --- |
| **Desktop** | 日常使用、管理项目与模型 | macOS 图形应用，提供项目、会话、文件、模型和权限界面。 |
| **TUI / CLI** | 在终端中工作或执行单次任务 | 在当前工作区启动交互界面，或通过 `biny run` 执行任务。 |

## 当前能力

### Agent

- 使用文件、搜索、Git、Shell 和联网搜索工具完成任务；
- 支持工具调用、流式输出、推理档位和用量统计；
- 支持 Plan 模式：先生成计划，不执行会产生副作用的操作；
- 支持 Workspace Skill、Plugin、MCP stdio server 和受限只读 Subagent。

### Desktop

- 打开和管理本地项目、会话与附件；
- 在“设置 → 模型”中连接 API、本地模型或账号订阅，并测试连接；
- 展示消息、工具过程、命令输出、权限请求和文件 Diff；
- 支持 DeepSeek、OpenAI、Anthropic、Gemini、Kimi、Qwen、Ollama 等厂商图标与接入方式。

## 快速开始

### 使用 macOS 桌面端

从 [GitHub Releases](https://github.com/Thinkya1/Biny/releases) 下载适合你 Mac 的安装包：

1. 打开 `.dmg`，将 `Biny` 拖入“应用程序”文件夹；或解压 `.zip` 后移动 `Biny.app`。
2. Apple 芯片 Mac 请选择 `arm64`，Intel Mac 请选择 `x64`。
3. 首次打开后，进入“设置 → 模型”，连接一个模型并测试连接。
4. 打开项目，开始任务。

如果 macOS 提示无法验证开发者，请在“系统设置 → 隐私与安全性”中允许打开 Biny。

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
  projects/<project-id>/  会话、附件、记忆和运行记录
```

升级后，旧版桌面端的配置和会话会自动复制到新位置，原文件会保留。CLI/TUI 仍使用当前工作区中的 `agent.config.json` 和 `.agent/`；它们与桌面端数据相互隔离。

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
