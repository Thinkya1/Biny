import { runAgentTask } from "../../agent/loop.js";
import { withCommandRuntime } from "../../runtime/CommandRuntime.js";

export async function runCommand(workspaceRoot: string, input: string): Promise<void> {
  await withCommandRuntime(workspaceRoot, async (runtime) => {
    const output = await runAgentTask(input, runtime);
    console.log(output);
    console.log(`\nSession: ${runtime.recorder.filePath}`);
  });
}
