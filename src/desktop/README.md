# Biny Desktop

Biny Desktop 是现有 Agent 系统的 macOS 交互层，不包含第二套 Agent。Electron Main 在同一 Node.js 进程中创建 `InteractiveAgentRuntime`，后者继续调用 `CommandRuntime`、`AgentSession`、Provider、Tool、Permission、Context 和 Session 模块；Renderer 只发送用户意图并投影结构化事件。

## 启动与构建

```bash
pnpm install
pnpm desktop:dev
```

开发模式由 `electron-vite` 同时构建 Main、Preload 和 Renderer，并打开独立窗口。

```bash
pnpm desktop:pack  # release/mac-arm64/Biny.app
pnpm desktop:dist  # release/Biny-<version>-<arch>.dmg/.zip
```

`desktop:dist` 只构建本地安装包，不会发布。日常发布时，在 GitHub Actions 的 `Prepare release` 工作流中输入版本号（例如 `0.2.2`），工作流会自动更新 `package.json`、提交版本变更并推送 `v0.2.2` tag；随后 tag 会触发发布工作流，为 Apple 芯片和 Intel Mac 分别构建 DMG/ZIP 并上传到对应 GitHub Release。安装包包含 Electron 运行时，用户不需要安装 Node.js 或 pnpm。需要重跑已有版本时，仍可直接运行 `Release macOS app` 并输入已有 tag。

公开 Release 由 `.github/workflows/release-desktop.yml` 强制检查 `MACOS_CERTIFICATE_BASE64`、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID` secrets。`electron-builder.yml` 已开启 hardened runtime；本地 `desktop:dist` 仍只生成未签名产物。

## 进程边界

```text
React Renderer
  │ window.biny（受控、类型安全 API）
  ▼
Preload / contextBridge
  │ ipcRenderer.invoke + 只读事件订阅
  ▼
Electron Main
  ├── DesktopUserDataStore（用户级工作区、项目数据迁移）
  ├── DesktopConfigStore（模型设置与受系统保护的凭据）
  ├── DesktopStateStore（项目、窗口、侧栏、会话 UI 元数据）
  ├── DesktopProjectService（Git、会话文件、附件、系统打开）
  └── DesktopAgentManager
        ▼
      InteractiveAgentRuntime
        ▼
      CommandRuntime → AgentSession → Provider / Tool / Permission / Context / Session
```

窗口开启 `contextIsolation` 和 Electron sandbox，并关闭 `nodeIntegration`。Renderer 不能导入 `fs`、`child_process`、`process` 或 Agent 对象；Preload 也不暴露任意 channel 的 `send`/`invoke`。

## IPC API

共享类型位于 `src/desktop/protocol.ts`，Main 中所有外部参数都再次经过 Zod 校验。

- 应用：`bootstrap`
- 项目：`openProject`、`selectProject`、`removeProject`、`refreshProject`、`revealProject`、`openProjectTerminal`
- 会话：`createSession`、`openSession`、`renameSession`、`pinSession`、`duplicateSession`、`deleteSession`、`showSessionMenu`
- Agent：`sendPrompt`、`cancelRun`、`compact`
- 权限与模型：`resolvePermission`、`setPermissionMode`、`switchModel`
- 文件与附件：`saveAttachment`、`resolveDroppedFile`、`listWorkspaceDirectory`、`readWorkspaceFile`、`openWorkspaceFile`
- UI：`setSidebarWidth`、`setFilePanelWidth`、`onMenuAction`
- 事件：`onAgentEvent`

`resolveDroppedFile` 只调用 Electron `webUtils.getPathForFile`，不授予 Renderer 通用文件系统权限。桌面端的配置、会话、附件和运行日志均写入应用用户数据目录；附件通过受限的 `@attachments/` 虚拟路径提供给 `read_file`，不会写进用户打开的项目目录。

## 用户数据目录

桌面端采用 Maka 式的用户级工作区：`app.getPath("userData")/workspaces/default`。在 macOS 上通常是 `~/Library/Application Support/Biny/workspaces/default`。

- `agent.config.json`：模型、服务地址和默认模型等非敏感设置。
- `credentials.json`：使用 Electron `safeStorage` 加密后的 API Key 与 OAuth refresh token；不会出现在 `agent.config.json` 中。
- `desktop-state.json`：项目列表、窗口尺寸、面板宽度和会话 UI 元数据。
- `projects/<project-id>/.agent/`：该项目的 session、附件、记忆、日志与 telemetry。

首次打开没有可用默认模型的项目时，桌面端会先进入模型配置页；只有默认模型具备有效凭据和服务地址后，才能开始任务。
首次启动新版桌面端时，旧的 `desktop-state.json`、项目 `agent.config.json` 和 `.agent/` 数据会迁移到用户数据目录；已有目标数据会与旧数据合并，目标中的新文件优先，旧文件保留，以免迁移意外造成数据丢失。CLI/TUI 继续使用项目级配置与 session，和桌面端的数据相互隔离。

## Agent 事件协议

协议定义位于 `src/runtime/agentEvents.ts`。每个运行事件都有 `sessionId`、`runId` 和 `timestamp`；消息、工具或权限事件还携带相应的 `messageId`、`toolCallId`、`requestId`。

- 运行：`run.started`、`run.completed`、`run.aborted`、`run.failed`
- 文本：`message.user`、`assistant.delta`、`assistant.completed`
- 公开状态：`reasoning.started`、`reasoning.status`、`reasoning.completed`
- 工具：`tool.started`、`tool.progress`、`tool.completed`、`tool.failed`
- 权限：`permission.requested`、`permission.resolved`
- 命令：`command.started`、`command.output`、`command.completed`
- 文件与 Diff：`file.read`、`file.changed`、`diff.created`
- 上下文：`context.updated`、`compact.started`、`compact.completed`

`reasoning.*` 会展示 Provider 实际返回的 reasoning 增量；如果 Provider 不返回 reasoning 内容，界面只展示状态并明确提示没有可展示内容，不会把“分析完成”当成思考正文。`run.completed.usage` 只在 Provider 返回真实 usage 时出现。

Renderer 对 `assistant.delta` 和命令输出按 animation frame 合并更新。当前会话在底部时自动跟随；用户向上滚动后停止抢占滚动位置。

## 会话和运行状态

- Desktop Agent 消息写入用户数据目录的 `projects/<project-id>/.agent/sessions/*.jsonl`，稳定事件类型没有变化。
- CLI/TUI 的项目级会话与 Desktop 的用户级会话相互隔离；两者都继续使用同一套 replay 逻辑恢复工具 ID、sequence、上下文摘要和 usage。
- Main 是运行状态的唯一事实来源。Renderer 重建后通过 `bootstrap`、workspace snapshot 和缓存的实时事件重新获取状态。
- 每个打开项目最多持有一个运行实例；切换页面不会中止任务，补充要求进入同一 runtime 队列。
- 停止按钮调用 runtime 的 `AbortController`，并拒绝正在等待的权限请求，不只是停止 UI 渲染。
- 权限请求保存在 Main runtime snapshot 中，切换会话或 Renderer 刷新不会丢失。

## 当前边界

- “已安排、插件、站点、拉取请求”导航仅提供入口和“暂未实现”状态。
- 语音输入、麦克风录音和实时语音对话没有实现；已有音频附件在模型声明支持 `audio` 时会作为原生 `file` message part 发送。
- 图片附件在模型声明支持 `vision` 时会转换为原生 `file` message part，否则仍以安全保存后的 `@attachments/` 路径交给 Agent 工具读取。
- 命令区域是实时日志视图，不是完整 PTY 终端模拟器。
- 本地包未签名、未公证；公开 Release 使用 CI secrets 完成签名和公证。
