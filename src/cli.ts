#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  die,
  ensureHerdrProtocol,
  HerdrError,
  notificationShow,
  pluginPaneOpen,
  readLine,
} from "./herdr";
import { loadConfig, readInvocationContext, resolveRepoRoot } from "./config";
import { parsePlaybookSeedScope, runInit } from "./init";
import { listWorkflows } from "./workflow/load";
import { WorkflowLoadError } from "./workflow/types";
import { runWorkflow } from "./run/runner";
import { startWebServer } from "./web/server";

export function parseArgs(args: string[]): {
  flags: Record<string, string>;
  bools: Set<string>;
  positional: string[];
  multi: Record<string, string[]>;
} {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  const multi: Record<string, string[]> = {};
  const setFlag = (key: string, value: string) => {
    flags[key] = value;
    (multi[key] ??= []).push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      setFlag(a.slice(2, eq), a.slice(eq + 1));
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        setFlag(key, next);
        i += 1;
      } else bools.add(key);
    } else positional.push(a);
  }
  return { flags, bools, positional, multi };
}

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

async function cmdInit(args: string[]): Promise<void> {
  const { bools, flags } = parseArgs(args);
  const repoRoot = await resolveRepoRoot();
  const seedFlag = flags.seed ?? flags["seed-playbooks"];
  const playbookScope = seedFlag ? parsePlaybookSeedScope(seedFlag) : undefined;
  if (seedFlag && !playbookScope) {
    die("usage: hwf init [--force] [--seed=global|repo|none]");
  }
  const result = await runInit(repoRoot, {
    force: bools.has("force") || bools.has("yes"),
    playbookScope,
    confirm: async () => {
      if (!process.stdin.isTTY) return false;
      process.stdout.write(`.hwf/config.yaml exists — overwrite? [y/N] `);
      const line = await readLine();
      return line.kind === "line" && line.text.trim().toLowerCase() === "y";
    },
    choosePlaybookScope:
      playbookScope || !process.stdin.isTTY
        ? undefined
        : async () => {
            process.stdout.write(
              "Seed handoff + worktree? [g]lobal ~/.hwf / [r]epo .hwf / [n]one [G]: ",
            );
            const line = await readLine();
            if (line.kind !== "line") return "global";
            const parsed = parsePlaybookSeedScope(line.text || "g");
            return parsed ?? "global";
          },
  });
  if (result.kind === "exists") die(`${result.path} already exists (pass --force to overwrite)`);
  const agents = result.agents.length ? ` (${result.agents.join(", ")})` : " (no agents on PATH)";
  const workflows = result.workflows.length
    ? `seeded repo workflows: ${result.workflows.join(", ")}\n`
    : "";
  const global = result.globalWorkflows.length
    ? `seeded global workflows (~/.hwf): ${result.globalWorkflows.join(", ")}\n`
    : "";
  const skipped =
    result.playbookScope === "skip" && !result.globalWorkflows.length
      ? "skipped handoff/worktree seeds\n"
      : "";
  process.stdout.write(`wrote ${result.path}${agents}\n${workflows}${global}${skipped}`);
}

async function cmdLaunch(): Promise<void> {
  await ensureHerdrProtocol();
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
  await ensureHerdrProtocol();
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
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
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

async function runPickerPopup(
  runPickerSession: (opts: {
    entries: Awaited<ReturnType<typeof listWorkflows>>;
    repoRoot: string;
    agents: Awaited<ReturnType<typeof loadConfig>>["agents"];
    sessions: Awaited<ReturnType<typeof loadConfig>>["sessions"];
    ctx: ReturnType<typeof readInvocationContext>;
  }) => Promise<number>,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die("picker requires a tty");

  const ctx = readInvocationContext();
  const root = process.env.HERDR_WORKFLOWS_REPO_ROOT ?? (await resolveRepoRoot(ctx.cwd));
  const { agents, sessions } = await loadConfig(root);
  const entries = await listWorkflows(root, Object.keys(agents));
  if (entries.length === 0) die("no workflows found");

  ctx.cwd = root;
  const code = await runPickerSession({
    entries,
    repoRoot: root,
    agents,
    sessions,
    ctx,
  });
  process.exit(code);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return cmdWeb([]);
    usage();
  }
  if (command === "launch") return cmdLaunch();
  if (command === "picker") {
    await ensureHerdrProtocol();
    preferOnDiskOpentuiLib();
    const { runPickerSession } = await import("./tui/picker");
    return runPickerPopup(runPickerSession);
  }
  if (command === "run") return cmdRun(rest);
  if (command === "init") return cmdInit(rest);
  if (command === "web") return cmdWeb(rest);
  usage();
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
