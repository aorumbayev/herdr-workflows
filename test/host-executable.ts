import { chmodSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";

function normalizeSh(body: string): string {
  const withShebang = body.startsWith("#!") ? body : `#!/bin/sh\n${body}`;
  return withShebang.endsWith("\n") ? withShebang : `${withShebang}\n`;
}

/** Write a POSIX stub script; return its path. */
export async function writeHostExecutable(basePath: string, sh: string): Promise<string> {
  await writeFile(basePath, normalizeSh(sh));
  await chmod(basePath, 0o755);
  return basePath;
}

export function writeHostExecutableSync(basePath: string, sh: string): string {
  writeFileSync(basePath, normalizeSh(sh));
  chmodSync(basePath, 0o755);
  return basePath;
}

/** Argv that writes `bytes` of zeros to stdout via the Bun runtime. */
export function bunAllocStdoutArgv(bytes: number): string[] {
  return ["bun", "-e", `process.stdout.write(Buffer.alloc(${bytes}))`];
}

/** Argv that writes exact UTF-8 text to stdout via the Bun runtime. */
export function bunWriteStdoutArgv(text: string): string[] {
  return ["bun", "-e", `process.stdout.write(${JSON.stringify(text)})`];
}
