# AGENTS.md

## 通用编码要求

- 对于可选对象属性，直接传 `undefined`，不要使用条件展开。
- 可选对象属性的类型不需要额外再写上 `undefined`。
- 只有一个参数的内部方法，不要为了风格统一硬改成 options object。
- 除了包自身的 `index.ts` 外，其他 `index.ts` 文件应优先使用 `export * from "./module"`。
- 不要过度封装，尤其是一两行的小函数，不要为了形式引入两层包装，直接内联即可。
- 减少冗余；每个函数、文件和模块只承担一个清晰职责。不要把无关逻辑堆进同一文件，优先通过明确边界解耦。
- 只有新增、删除或改变功能/用户可见行为时才更新 `PROJECT_DESCRIPTION.local.md`；纯重构、测试、格式化或其他非功能改动无需更新。
## 当前项目约束
- 真实模型 API key 可从 `providers.<alias>.apiKey` 或 `providers.<alias>.apiKeyEnv` 读取。不得把真实 key 写入代码、README、测试快照或 session 示例；配置文件中的 key 应视作敏感本地数据。
- 同样不要把业务逻辑堆进 TUI 组件；入口只负责装配和路由，具体上下文、会话、记忆和提示词逻辑应落在各自模块。
- 保持 `pnpm typecheck` 通过。
- 修改工具行为时，确保 session 仍记录 `user_message`、`assistant_message`、`tool_call`、`tool_result`、`error` 这些稳定事件类型。

## TUI 开发规范

- 编写或修改 TUI 前，优先查看本地 `.agents/skills/write-tui/SKILL.md` 和 `.agents/skills/write-tui/DESIGN.md`。`.agents/` 是本地参考资料，已被 `.gitignore` 忽略，不要提交到 GitHub。
- TUI 入口保持在 `src/tui/index.tsx`，CLI 只负责注册和启动 `tui` 命令，不要把 TUI 交互逻辑写进 `src/cli/commands/tui.ts`。
- `src/tui/App.tsx` 负责组合 runtime、全局状态和顶层布局；复杂逻辑应继续下沉到 `src/tui/runtime/`、`src/tui/components/`、`src/tui/slashCommands.ts` 或独立工具函数。
- `src/tui/runtime/` 负责把 Agent/Tool/Session 流程转换成 TUI 可消费事件；不要让 Ink 组件直接调用工具、写 session 或访问 provider。
- `src/tui/components/` 只处理展示和本地键盘交互。组件可以触发回调，但不要直接读写 session 文件、直接执行工具或直接调用 provider。
- Slash command 的声明集中维护，不要在多个组件里复制命令列表；命令执行不要使用 `console.log` / `console.error` 干扰 Ink 渲染，应通过 TUI 事件或状态展示。
- 输入框必须稳定停留在底部。App 布局应保持：Header 固定高度，消息区域 `flexGrow`，InputBox 固定高度，StatusBar 固定高度。不要用大量空行、字符串空格或手动光标 escape 撑布局。
- 输入框优先使用简单受控文本和同一行视觉光标；不要同时使用 Ink `useCursor` 和自定义光标，避免真实光标与视觉光标错位。
- 空格键只能作为普通输入字符追加，不得触发选择、确认、滚动或布局变化。
- TUI 运行期间不要直接向 stdout/stderr 打印日志。需要调试时写本地临时日志，并确保不提交。

## 颜色和交互约束

- Biny 当前使用 Ink 的基础颜色即可；新增颜色时要保持语义清楚，不要在多个组件里散落魔法颜色。
- 如果后续引入主题系统，颜色 token 应集中维护，组件不要绕过主题直接硬编码大量颜色。
- 键盘输入处理要区分普通可打印字符、功能键和控制键。普通字符统一走追加输入逻辑；功能键只处理明确需要的 Enter、Tab、Backspace、上下键、Ctrl+C。
- 不要为了临时视觉效果写终端 escape 控制光标形状或位置，除非同时验证中文输入法、空格、Backspace、Enter 和 Ctrl+C。
