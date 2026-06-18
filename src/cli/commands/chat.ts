import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../../config/loader.js";
import { MockProvider } from "../../llm/mock.js";
import { OpenAICompatibleProvider } from "../../llm/openaiCompatible.js";
import type { LLMProvider } from "../../llm/provider.js";
import { runAgentTask } from "../../agent/loop.js";
import { ensureAgentDirs } from "../../session/store.js";
import { SessionRecorder } from "../../session/recorder.js";

export async function chatCommand(workspaceRoot: string): Promise<void> {
  await ensureAgentDirs(workspaceRoot);
  const config = await loadConfig(workspaceRoot);
  const recorder = new SessionRecorder(workspaceRoot);
  const llm = createProvider(config.model.provider, config.model.baseUrl, config.model.model, process.env[config.model.apiKeyEnv]);
  const rl = createInterface({ input, output });

  console.log(`Session: ${recorder.filePath}`);
  console.log("Type /exit to quit.");
  try {
    while (true) {
      const text = (await rl.question("> ")).trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      const result = await runAgentTask(text, { workspaceRoot, config, recorder, llm });
      console.log(result);
    }
  } finally {
    rl.close();
    await recorder.close();
  }
}

function createProvider(provider: string, baseUrl: string, model: string, apiKey: string | undefined): LLMProvider {
  if (provider === "openai-compatible" && apiKey) {
    return new OpenAICompatibleProvider({ baseUrl, model, apiKey });
  }
  return new MockProvider();
}
