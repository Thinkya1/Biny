import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface ConfirmOptions {
  requireFullYes?: boolean;
}

export async function confirmAction(title: string, details: string, options: ConfirmOptions = {}): Promise<boolean> {
  output.write(`\n${title}\n${details}\nAllow? ${options.requireFullYes ? "type yes to confirm" : "yes/no"}\n`);
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("> ")).trim().toLowerCase();
    if (options.requireFullYes) return answer === "yes";
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
