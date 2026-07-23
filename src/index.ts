/**
 * 包入口占位模块。
 *
 * 当前 CLI 的主要入口在 `src/cli/index.ts`，这里仅保留一个最小导出，用来验证 TypeScript
 * 构建链路和包级导入是否正常。
 */
export const greeting = "hello";

export type { AgentTurnOutcome, AgentTurnStatus, AgentTurnStopReason } from "./agent/types.js";
export * from "./harness/TaskAttemptLoop.js";
export * from "./harness/AgentAttemptExecutor.js";
export * from "./harness/AcceptanceVerifier.js";
export * from "./harness/TaskContractFactory.js";
export * from "./harness/TaskRunStore.js";
export * from "./harness/types.js";
export * from "./runtime/RootRunLedger.js";
export * from "./runtime/ManagedProcessService.js";
