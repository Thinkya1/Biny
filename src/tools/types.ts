export interface Tool<TArgs, TResult> {
  name: string;
  description: string;
  execute(args: TArgs): Promise<TResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  ignore: string[];
}
