#!/usr/bin/env bun
import { HerdrError, notificationShow, pluginPaneOpen } from "./adapter/client";
import { runPickerPopup } from "./adapter/picker";
import { die, promptLine } from "./adapter/popup";
import { loadConfig } from "./config";
import { readInvocationContext } from "./context";
import { runInit } from "./init";
import { WorkflowLoadError } from "./workflows";
import { resolveRepoRoot } from "./repo";
import { runWorkflow } from "./runner";
import { runManage } from "./tui/manage";

function usage(): never {
  die("usage: hwf|herdr-workflows [<run|init|launch|picker>]  (no args: manage TUI)");
}

function parseArgs(args: string[]): {
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

async function cmdInit(args: string[]): Promise<void> {
  const { bools } = parseArgs(args);
  const repoRoot = await resolveRepoRoot();
  const result = await runInit(repoRoot, {
    force: bools.has("force") || bools.has("yes"),
    confirm: async () => {
      if (!process.stdin.isTTY) return false;
      process.stdout.write(`.hwf/config.yaml exists — overwrite? [y/N] `);
      const line = await promptLine("");
      return line.kind === "line" && line.text.trim().toLowerCase() === "y";
    },
  });
  if (result.kind === "exists") die(`${result.path} already exists (pass --force to overwrite)`);
  const agents = result.agents.length ? ` (${result.agents.join(", ")})` : " (no agents on PATH)";
  const workflows = result.workflows.length
    ? `seeded example workflows: ${result.workflows.join(", ")}\n`
    : "";
  process.stdout.write(`wrote ${result.path}${agents}\n${workflows}`);
}

async function main(): Promise<void> {
  // Older cached manifests invoked `bin/hook.mjs herdr <cmd>`; strip that prefix so a stale
  // plugins.json still reaches launch/picker until the next `bun run install:dev` re-links.
  const argv = process.argv.slice(2);
  const args = argv[0] === "herdr" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return runManage();
    usage();
  }
  if (command === "launch") return cmdLaunch();
  if (command === "picker") return runPickerPopup();
  if (command === "run") return cmdRun(rest);
  if (command === "init") return cmdInit(rest);
  usage();
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
