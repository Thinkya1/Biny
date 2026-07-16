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

本地打包产物未签名。公开分发前仍需在 `electron-builder.yml` 中配置 Apple Developer 签名、hardened runtime 和 notarization。

## 进程边界

```text
React Renderer
  │ window.biny（受控、类型安全 API）
  ▼
Preload / contextBridge
  │ ipcRenderer.invoke + 只读事件订阅
  ▼
Electron Main
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

`resolveDroppedFile` 只调用 Electron `webUtils.getPathForFile`，不授予 Renderer 通用文件系统权限。附件在 Main 中限制数量、大小和文件名，并写入当前项目的 `.agent/attachments/`。

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

`reasoning.*` 仅表示“读取文件”“运行命令”等公开执行状态，不传递或展示模型私有思维链。`run.completed.usage` 只在 Provider 返回真实 usage 时出现。

Renderer 对 `assistant.delta` 和命令输出按 animation frame 合并更新。当前会话在底部时自动跟随；用户向上滚动后停止抢占滚动位置。

## 会话和运行状态

- Agent 消息仍写入 `.agent/sessions/*.jsonl`，稳定事件类型没有变化。
- CLI、TUI 和 Desktop 可以打开同一个 session；工具 ID、sequence、上下文摘要和 usage 都从现有 replay 逻辑恢复。
- Main 是运行状态的唯一事实来源。Renderer 重建后通过 `bootstrap`、workspace snapshot 和缓存的实时事件重新获取状态。
- 每个打开项目最多持有一个运行实例；切换页面不会中止任务，补充要求进入同一 runtime 队列。
- 停止按钮调用 runtime 的 `AbortController`，并拒绝正在等待的权限请求，不只是停止 UI 渲染。
- 权限请求保存在 Main runtime snapshot 中，切换会话或 Renderer 刷新不会丢失。

## 目前明确未实现

- “已安排、插件、站点、拉取请求”导航仅提供入口和“暂未实现”状态。
- 语音输入没有实现。
- 图片附件尚未转换为模型厂商的原生多模态 message part，仅以安全保存后的工作区路径交给当前文本 Agent。
- 命令区域是实时日志视图，不是完整 PTY 终端模拟器。
- 本地包未签名、未公证。
