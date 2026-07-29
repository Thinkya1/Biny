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
  ├── DesktopUserDataStore（附件/非项目会话、旧项目会话迁回项目目录）
  ├── DesktopConfigStore（全局模型设置与 macOS Keychain 凭据）
  ├── DesktopStateStore（项目、窗口、侧栏、会话 UI 元数据）
  ├── DesktopProjectService（Git、项目会话文件、附件、系统打开）
  └── DesktopAgentManager
        ▼
      InteractiveAgentRuntime（persistenceRoot = 项目路径）
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

`resolveDroppedFile` 只调用 Electron `webUtils.getPathForFile`，不授予 Renderer 通用文件系统权限。桌面端的**项目会话和附件**写入打开项目的 `.biny/`（与 TUI/CLI 共用）；**配置、凭据、UI 状态和非项目会话**仍在应用用户数据目录。附件通过受限的 `@attachments/` 虚拟路径提供给 `read_file`，不会混进用户的业务文件目录。

## 用户数据目录

桌面端 UI 数据目录：`app.getPath("userData")/workspaces/default`。在 macOS 上通常是 `~/Library/Application Support/Biny/workspaces/default`。模型配置单独使用全局 `~/.biny/agent/`，并可由 `BINY_AGENT_DIR` 覆盖。

- `desktop-state.json`：项目列表、窗口尺寸、面板宽度和会话 UI 元数据。
- `global/.biny/sessions/`：非项目会话（不绑定某个打开的项目路径）。

全局 `agent.config.json` 只保存 provider/model 元数据和运行设置。macOS 的 API key、OAuth access/refresh token 通过 `com.biny.agent` Keychain service 保存，CLI/TUI 与 Electron 使用相同的 account 命名；非 macOS 使用 `apiKeyEnv` 环境变量，不写本地凭据文件。

模型的 reasoning effort 是模型级能力元数据，不是全局固定档位。TUI 的 `/model` 会先选模型，再展示该模型声明的选项；Desktop 输入区也只在当前模型有可调 effort 时显示思考菜单。Desktop 设置里的 provider `/models` 结果与静态配置合并，启用模型后写入同一份全局模型元数据。

## 项目会话目录

打开某个项目后，Desktop 与 TUI/CLI 使用同一套项目级持久化根：

- `<project>/.biny/sessions/`：项目问答历史（两端共用）
- `<project>/.biny/attachments/`：Desktop/TUI/CLI 共用的图片、音频等附件
- `<project>/.biny/` 下的 runs、tasks、logs、memory、processes、telemetry：与会话配套的运行时数据

首次打开项目时，旧工作区 `.agent/` 以及用户数据目录的 `projects/<project-id>/.agent/`（或 `.biny/`）会**单向合并**到 `<project>/.biny/`：目标中已有的文件优先保留，缺失的普通文件被复制过来；软链接不会被跟随。之后新会话和附件都只写入项目目录。

首次打开没有可用默认模型的项目时，桌面端会先进入模型配置页；只有默认模型具备有效凭据和服务地址后，才能开始任务。项目 `.biny/settings.json` 可以覆盖默认模型和运行参数，但不能配置 provider 或凭据。
旧的 `desktop-state.json` 会按既有逻辑迁移；项目内旧 `agent.config.json` 和旧桌面模型配置保持原样，`biny doctor` 只提示位置和迁移建议，不会自动复制或覆盖全局配置。

## Agent 事件协议

协议定义位于 `src/runtime/agentEvents.ts`。Runtime 通过 `AgentRuntimeUpdate` 同时发布可选事件与完整 snapshot，Renderer 不再从事件自行拼装运行状态。每个运行事件都有 `sessionId`、`runId` 和 `timestamp`；消息、工具或权限事件还携带相应的 `messageId`、`toolCallId`、`requestId`。

- 运行：`run.queued`、`run.queue.updated`、`run.started`、`run.completed`、`run.incomplete`、`run.aborted`、`run.failed`
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

- Desktop 与 TUI/CLI 的项目会话都写入 `<project>/.biny/sessions/*.jsonl`，稳定事件类型没有变化；同一项目两端可见同一份历史。
- 非项目会话保留在用户数据目录的 `global/.biny/sessions/`。
- 两端继续使用同一套 replay 逻辑恢复工具 ID、sequence、上下文摘要和 usage。
- `InteractiveAgentRuntime` 是运行状态的唯一事实来源。Renderer 重建后通过 `bootstrap`、workspace snapshot 和后续 `AgentRuntimeUpdate` 获取状态。
- 实时状态是一个带单调 `revision` 的闭合 `RunState`：`idle`、`runs`、`maintenance`、`background_subagent` 互斥，Renderer 不再分别维护 `activeRun`、队列和权限请求。
- Desktop 与 TUI 的共享 slash command 来自 `src/runtime/commandRegistry.ts`，状态读取和运行时操作由 `src/runtime/commands.ts` 执行；界面层只保留帮助、选择器、清屏等本地行为。
- Desktop 与 TUI/CLI 可以同时打开同一个项目；执行锁落在 `<project>/.biny/runs/session-<sessionId>.lock`，同一 Session 同一时刻只能有一个执行者，不同 Session 可以并行执行。
- 当前阶段按 Pi 的单进程、单 AgentSession 模型运行：同一 Session 被另一端执行时，第二个运行时会收到 Session 占用提示，暂不支持跨进程 attach 到实时执行。TODO：引入 SessionHost 后再支持多客户端共同挂载同一 Session。
- 切换页面不会中止任务；Desktop 与 TUI 在 Session 忙碌时都拒绝创建隐式排队任务，编辑中的输入保持不变。
- 停止按钮调用 runtime 的 `AbortController`，并拒绝正在等待的权限请求，不只是停止 UI 渲染。
- 权限请求保存在 Main runtime snapshot 中，切换会话或 Renderer 刷新不会丢失。

## 当前边界

- 设置页和输入区只暴露已经接通的能力，不保留“开发中”占位入口。
- 输入区的上下文用量来自运行时上报的 `context.updated`，因此只在当前会话跑过至少一轮后显示。
- 语音输入、麦克风录音和实时语音对话没有实现；已有音频附件在模型声明支持 `audio` 时会作为原生 `file` message part 发送。
- 图片附件会转换为原生 `file` message part；当前模型未明确声明 `vision` 时，发送会直接失败并提示切换或配置模型，而不会静默降级。
- 命令区域是实时日志视图，不是完整 PTY 终端模拟器。
- 本地包未签名、未公证；公开 Release 使用 CI secrets 完成签名和公证。
