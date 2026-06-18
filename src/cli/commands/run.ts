import { loadConfig } from "../../config/loader.js";
import { MockProvider } from "../../llm/mock.js";
import { OpenAICompatibleProvider } from "../../llm/openaiCompatible.js";
import type { LLMProvider } from "../../llm/provider.js";
import { runAgentTask } from "../../agent/loop.js";
import { ensureAgentDirs } from "../../session/store.js";
import { SessionRecorder } from "../../session/recorder.js";

export async function runCommand(workspaceRoot: string, input: string): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  const config = await loadConfig(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const llm = createProvider(config.model.provider, config.model.baseUrl, config.model.model, process.env[config.model.apiKeyEnv]);

  try {
    const output = await runAgentTask(input, { workspaceRoot, config, recorder, llm });
    console.log(output);
    console.log(`\nSession: ${recorder.filePath}`);
  } finally {
    await recorder.close();
  }
}

function createProvider(provider: string, baseUrl: string, model: string, apiKey: string | undefined): LLMProvider {
  if (provider === "openai-compatible" && apiKey) {
    return new OpenAICompatibleProvider({ baseUrl, model, apiKey });
  }
  return new MockProvider();
}
