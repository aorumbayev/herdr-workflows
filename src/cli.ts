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
import { EXAMPLES_URL, runInit } from "./init";
import { IMPORT_DISCLAIMER, parseImportScope, runImport } from "./workflow/import";
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
  die(
    "usage: hwf|herdr-workflows [<run|init|workflow import|launch|picker|web>]  (no args: web UI)",
  );
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
  const { bools } = parseArgs(args);
  const global = bools.has("global");
  const repoRoot = await resolveRepoRoot();
  const result = await runInit(repoRoot, {
    force: bools.has("force") || bools.has("yes"),
    global,
    confirm: async () => {
      if (!process.stdin.isTTY) return false;
      const label = global ? "global plugin config" : ".hwf/config.yaml";
      process.stdout.write(`${label} exists — overwrite? [y/N] `);
      const line = await readLine();
      return line.kind === "line" && line.text.trim().toLowerCase() === "y";
    },
  });
  if (result.kind === "exists") die(`${result.path} already exists (pass --force to overwrite)`);
  const profiles = result.profiles.length
    ? ` (${result.profiles.join(", ")})`
    : " (no agent kinds on PATH)";
  process.stdout.write(
    `wrote ${result.path}${profiles}\n` +
      (global
        ? `profiles apply to every repo; keep personal workflows in ~/.hwf/workflows\n`
        : `no workflows yet — pick ready-made ones at ${EXAMPLES_URL}\n` +
          `each card copies an \`hwf workflow import\` command you can paste here\n`),
  );
}

async function cmdWorkflowImport(args: string[]): Promise<void> {
  const { bools, flags, positional } = parseArgs(args);
  const payload = positional[0];
  if (!payload) {
    die('usage: hwf workflow import "<base64>" [--to=repo|global] [--yes] [--force]');
  }
  const scope = flags.to ? parseImportScope(flags.to) : undefined;
  if (flags.to && !scope) die(`--to expects repo or global, got '${flags.to}'`);
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const preapproved = bools.has("yes") || bools.has("y");
  if (!tty && !(preapproved && scope)) {
    die("not a tty: pass --yes and --to=repo|global to import without the review prompts");
  }
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
  try {
    const outcome = await runImport(payload, {
      repoRoot,
      scope,
      force: bools.has("force"),
      prompts: preapproved
        ? undefined
        : {
            confirm: async (preview) => {
              process.stdout.write(`${IMPORT_DISCLAIMER}\n\n${preview}\n`);
              process.stdout.write("Reviewed the workflow above and want it? [y/N] ");
              const line = await readLine();
              return line.kind === "line" && line.text.trim().toLowerCase() === "y";
            },
            chooseScope: async () => {
              process.stdout.write(`Install into [r]epo ${repoRoot}/.hwf / [g]lobal ~/.hwf [R]: `);
              const line = await readLine();
              if (line.kind !== "line") return "repo";
              return parseImportScope(line.text || "r") ?? "repo";
            },
          },
    });
    if ("aborted" in outcome) {
      process.stdout.write("aborted — nothing written\n");
      return;
    }
    const r = outcome.result;
    process.stdout.write(
      r.status === "written"
        ? `wrote ${r.path}\n`
        : `kept existing ${r.path} (--force to replace)\n`,
    );
  } catch (error) {
    if (error instanceof WorkflowLoadError) die(error.message);
    throw error;
  }
}

async function cmdLaunch(): Promise<void> {
  await ensureHerdrProtocol();
  // Picker popup is rooted at the plugin dir; forward the invoking repo and context.
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
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || resolveRepoRoot();
  const config = await loadConfig(repoRoot);
  const ctx = readInvocationContext();
  ctx.cwd = repoRoot;
  try {
    const result = await runWorkflow({
      name,
      repoRoot,
      config,
      ctx,
      prompt: flags.prompt,
      inputs: parseInputFlags(multi.input ?? []),
      onProgress: (i, n, label, outcome = "ok") => {
        const suffix = outcome === "ok" ? "" : ` ${outcome}`;
        process.stdout.write(`[${i}/${n}] ${label}${suffix}\n`);
      },
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
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
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

async function runPickerPopup(picker: typeof import("./tui/picker")): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die("picker requires a tty");

  const ctx = readInvocationContext();
  const root = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot(ctx.cwd));
  const config = await loadConfig(root);
  const entries = await listWorkflows(root, config);
  if (!picker.hasVisibleEntries(entries)) die("no workflows found");

  ctx.cwd = root;
  const code = await picker.runPickerSession({
    entries,
    repoRoot: root,
    config,
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
    return runPickerPopup(await import("./tui/picker"));
  }
  if (command === "run") return cmdRun(rest);
  if (command === "init") return cmdInit(rest);
  if (command === "workflow") {
    if (rest[0] !== "import") die('usage: hwf workflow import "<base64>"');
    return cmdWorkflowImport(rest.slice(1));
  }
  if (command === "web") return cmdWeb(rest);
  usage();
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
