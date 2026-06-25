/**
 * 工具公共入口模块。
 *
 * 新的 Agent Loop 只依赖这里导出的 Tool 契约，具体工具仍沿用现有实现。
 * 这个文件让未来迁移工具目录结构时，不必修改 agent loop 的导入路径。
 */
export type {
  RunnableToolExecution,
  Tool,
  ToolContext,
  ToolExecution,
  ToolExecutionContext,
  ToolInputDisplay,
  ToolUpdate
} from "./types.js";
