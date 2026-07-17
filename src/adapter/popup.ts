import { readLine, type PromptResult } from "./stdin";

export function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function promptLine(prompt: string): Promise<PromptResult> {
  process.stdout.write(prompt);
  return readLine();
}
