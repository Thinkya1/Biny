# AGENTS.md

## 通用编码要求

- 对于可选对象属性，直接传 `undefined`，不要使用条件展开。
- 可选对象属性的类型不需要额外再写上 `undefined`。
- 只有一个参数的内部方法，不要为了风格统一硬改成 options object。
- 除了包自身的 `index.ts` 外，其他 `index.ts` 文件应优先使用 `export * from "./module"`。
- 不要过度封装，尤其是一两行的小函数，不要为了形式引入两层包装，直接内联即可。

## 当前项目约束

- 暂时不要接入 OpenAI、Claude、Gemini 或任何真实模型。
- 当前默认模型实现是 `MockProvider`。
- 新功能优先保持 CLI、Runtime、AgentLoop、Tool、Permission、Session、Context 的边界清晰。
- 不要把新能力继续堆进 `agent/loop.ts` 或 `cli/commands/chat.ts`；能抽到 runtime、prompt、tools、session、permission 的，应放到对应模块。
- 保持 `pnpm typecheck` 通过。
- 修改工具行为时，确保 session 仍记录 `user_message`、`assistant_message`、`tool_call`、`tool_result`、`error` 这些稳定事件类型。
