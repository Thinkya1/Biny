/**
 * TUI 状态入口模块。
 *
 * App 从这里拿初始状态和 reducer，避免顶层组件直接关心状态实现文件的位置。
 * 目前实现仍复用 `reducer.ts`，后续如果拆分 action、selector 或 store，可以从这里继续收口。
 */
export { createInitialTuiState, tuiReducer } from "./reducer.js";
