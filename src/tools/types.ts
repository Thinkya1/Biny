export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  // Tool 只负责执行能力。权限确认、session 记录和 UI 展示都在调用方处理。
  execute(args: TArgs): Promise<TResult>;
}

export interface ToolContext {
  // 所有内置工具都绑定在当前 workspace 内，不能自行选择任意系统路径。
  workspaceRoot: string;
  ignore: string[];
}
