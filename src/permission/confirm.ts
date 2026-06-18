import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirmAction(title: string, details: string): Promise<boolean> {
  output.write(`\n${title}\n${details}\nAllow? yes/no\n`);
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("> ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
