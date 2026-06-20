export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CommandAnalysisInput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileEditInput {
  instruction: string;
  path: string;
  content: string;
}

export interface FileEditProposal {
  oldText: string;
  newText: string;
  explanation: string;
}

export interface LLMProvider {
  chat(messages: ChatMessage[]): Promise<string>;
  streamChat?(messages: ChatMessage[], onDelta: (delta: string) => void, options?: { signal?: AbortSignal }): Promise<string>;
  analyzeCommandResult(input: CommandAnalysisInput): Promise<string>;
  proposeFileEdit(input: FileEditInput): Promise<FileEditProposal>;
}
