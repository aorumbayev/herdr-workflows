#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrError, notificationShow, pluginPaneOpen } from "./adapter/client";
import { die } from "./adapter/popup";
import { parseArgs } from "./cli-args";
import { cmdInit } from "./cmd-init";
import { loadConfig } from "./config";
import { readInvocationContext } from "./context";
import { WorkflowLoadError } from "./workflows";
import { resolveRepoRoot } from "./repo";
import { runWorkflow } from "./runner";
import { startWebServer } from "./web/server";

function usage(): never {
  die("usage: hwf|herdr-workflows [<run|init|launch|picker|web>]  (no args: web UI)");
}

function parseInputFlags(values: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const kv of values) {
    const eq = kv.indexOf("=");
    if (eq <= 0) die(`--input expects name=value, got '${kv}'`);
    inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return inputs;
}

async function cmdLaunch(): Promise<void> {
  // The picker runs in a fresh popup pane rooted at the plugin dir, so forward the invoking
  // pane's repo (and raw context) — otherwise workflow discovery and {pane} target the wrong place.
  const ctx = readInvocationContext();
  const repoRoot = await resolveRepoRoot(ctx.cwd);
  const env: Record<string, string> = { HERDR_WORKFLOWS_REPO_ROOT: repoRoot };
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON)
    env.HERDR_PLUGIN_CONTEXT_JSON = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  try {
    await pluginPaneOpen({ entrypoint: "picker", placement: "popup", env });
  } catch (error) {
    if (error instanceof HerdrError && error.code === "ui_busy") {
      await notificationShow("herdr-workflows", "Another popup is open — close it first.");
      return;
    }
    throw error;
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const { flags, positional, multi } = parseArgs(args);
  const name = positional[0];
  if (!name) die("usage: hwf|herdr-workflows run <name> [--prompt …] [--input name=value …]");
  const repoRoot = await resolveRepoRoot();
  const { agents, sessions } = await loadConfig(repoRoot);
  const ctx = readInvocationContext();
  ctx.cwd = repoRoot;
  try {
    const result = await runWorkflow({
      name,
      repoRoot,
      agents,
      sessions,
      ctx,
      prompt: flags.prompt,
      inputs: parseInputFlags(multi.input ?? []),
      onProgress: (i, n, label) => process.stdout.write(`[${i}/${n}] ${label}\n`),
      onStderr: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
    });
    if (!result.ok) die(result.error);
  } catch (error) {
    if (error instanceof WorkflowLoadError) die(error.message);
    throw error;
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // browser launch is best-effort; the printed URL still works
  }
}

async function cmdWeb(args: string[]): Promise<void> {
  const { flags, bools } = parseArgs(args);
  const port = flags.port !== undefined ? Number(flags.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    die(`--port expects an integer between 1 and 65535, got '${flags.port}'`);
  const repoRoot = await resolveRepoRoot();
  const { url } = await startWebServer({ repoRoot, port });
  process.stdout.write(`herdr-workflows web · ${url}\n`);
  if (!bools.has("no-open")) openBrowser(url);
}

// bun --compile re-extracts the embedded libopentui to a temp file per spawn (~200ms on the
// picker hot path); point opentui at the on-disk copy when node_modules is present.
function preferOnDiskOpentuiLib(): void {
  if (process.env.OTUI_ASSET_ROOT) return;
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const musl = process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : "";
  const asset = join(
    `@opentui/core-${process.platform}-${process.arch}${musl}`,
    process.platform === "darwin" ? "libopentui.dylib" : "libopentui.so",
  );
  const roots = [
    join(dirname(process.execPath), "..", "node_modules"), // compiled: bin/../node_modules
    join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules"), // dev: src/../node_modules
  ];
  for (const root of roots) {
    if (existsSync(join(root, asset))) {
      process.env.OTUI_ASSET_ROOT = root;
      return;
    }
  }
}

async function main(): Promise<void> {
  // Older cached manifests invoked `bin/hook.mjs herdr <cmd>`; strip that prefix so a stale
  // plugins.json still reaches launch/picker until the next `bun run install:dev` re-links.
  const argv = process.argv.slice(2);
  const args = argv[0] === "herdr" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return cmdWeb([]);
    usage();
  }
  if (command === "launch") return cmdLaunch();
  if (command === "picker") {
    preferOnDiskOpentuiLib();
    const { runPickerPopup } = await import("./adapter/picker");
    return runPickerPopup();
  }
  if (command === "run") return cmdRun(rest);
  if (command === "init") return cmdInit(rest);
  if (command === "web") return cmdWeb(rest);
  usage();
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
