#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import manifest from "../herdr-plugin.toml";
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
import { listWorkflows, loadWorkflow, resolveDynamicChoices } from "./workflow/load";
import { evaluateWhen } from "./workflow/conditions";
import {
  WORKFLOW_FORMAT,
  WorkflowLoadError,
  type InputSpec,
  type WhenSpec,
} from "./workflow/types";
import { CaptureLimitError } from "./limits";
import { runWorkflow } from "./run/runner";
import { parseLaunchPayload, retireOnCodeChange } from "./tui/run-launch";
import { ensureWorkbench } from "./web/endpoint";
import { appendRouteHash, parseWebRoute } from "./web/route";
import { runSetup } from "./setup/run";
import { runUpdate } from "./update";

function collectInput(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new InvalidArgumentError(`--input expects name=value, got '${value}'`);
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(`--port expects an integer between 1 and 65535, got '${value}'`);
  }
  return port;
}

async function cmdInit(opts: { force?: boolean; global?: boolean }): Promise<void> {
  const global = Boolean(opts.global);
  const repoRoot = await resolveRepoRoot();
  const result = await runInit(repoRoot, {
    force: Boolean(opts.force),
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

async function cmdWorkflowImport(
  payload: string,
  opts: { to?: "repo" | "global"; yes?: boolean; force?: boolean },
): Promise<void> {
  const scope = opts.to;
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const preapproved = Boolean(opts.yes);
  if (!tty && !(preapproved && scope)) {
    die("not a tty: pass --yes and --to=repo|global to import without the review prompts");
  }
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
  try {
    const outcome = await runImport(payload, {
      repoRoot,
      scope,
      force: Boolean(opts.force),
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
    if (r.status === "conflicts") {
      const names = r.conflicts.map((c) => c.name).join(", ");
      die(`existing workflows would be replaced (${names}); pass --force to replace all`);
    }
    for (const row of r.results) {
      process.stdout.write(`wrote ${row.path}\n`);
    }
  } catch (error) {
    if (error instanceof WorkflowLoadError || error instanceof CaptureLimitError)
      die(error.message);
    throw error;
  }
}

function formatWhenClause(clause: WhenSpec): string {
  if (clause.kind === "truthy") return `{{${clause.path}}}`;
  return `{{${clause.path}}} ${clause.negate ? "!=" : "=="} ${JSON.stringify(clause.value)}`;
}

function formatInputInspect(spec: InputSpec, resolved?: string[]): string[] {
  const lines = [`${spec.name}:`];
  lines.push(`  type: ${spec.type}`);
  if (spec.description) lines.push(`  description: ${spec.description}`);
  if (spec.when && spec.when.length > 0) {
    const text =
      spec.when.length === 1
        ? formatWhenClause(spec.when[0]!)
        : `[${spec.when.map(formatWhenClause).join(", ")}]`;
    lines.push(`  when: ${text}`);
  }
  if (spec.default !== undefined) lines.push(`  default: ${spec.default}`);
  if (spec.minLength !== undefined) lines.push(`  min_length: ${spec.minLength}`);
  if (spec.allowCustom === true) lines.push(`  allow_custom: true`);
  if (spec.dynamicOptions) {
    lines.push(
      `  options.run: [${spec.dynamicOptions.run.map((el) => JSON.stringify(el)).join(", ")}]`,
    );
    if (resolved) {
      lines.push(`  options: [${resolved.map((el) => JSON.stringify(el)).join(", ")}]`);
    }
  } else if (spec.options) {
    lines.push(`  options: [${spec.options.map((el) => JSON.stringify(el)).join(", ")}]`);
  }
  return lines;
}

async function cmdWorkflowInspect(
  name: string,
  opts: { input?: Record<string, string>; resolve?: boolean },
): Promise<void> {
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
  const config = await loadConfig(repoRoot);
  let workflow;
  try {
    workflow = await loadWorkflow(name, repoRoot, config);
  } catch (error) {
    if (error instanceof WorkflowLoadError) die(error.message);
    throw error;
  }
  const provided = opts.input ?? {};
  for (const key of Object.keys(provided)) {
    if (!workflow.inputs.some((input) => input.name === key)) {
      die(`unknown input '${key}'`);
    }
  }
  const domains: Record<string, string[]> = {};
  const values: Record<string, string> = { ...provided };
  if (opts.resolve) {
    for (const spec of workflow.inputs) {
      if (!evaluateWhen(spec.when, { inputs: values, steps: {}, context: {} })) continue;
      if (spec.default !== undefined && !Object.hasOwn(values, spec.name)) {
        values[spec.name] = spec.default;
      }
      if (spec.dynamicOptions) {
        try {
          domains[spec.name] = await resolveDynamicChoices(
            workflow.file,
            spec.name,
            spec.dynamicOptions,
            repoRoot,
          );
        } catch (error) {
          die(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
  const lines: string[] = [`workflow: ${workflow.name}`, `inputs:`];
  if (workflow.inputs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const spec of workflow.inputs) {
      lines.push(
        ...formatInputInspect(spec, opts.resolve ? domains[spec.name] : undefined).map(
          (line) => `  ${line}`,
        ),
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
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

async function cmdRun(
  name: string,
  opts: { input?: Record<string, string>; launchPayload?: boolean },
): Promise<void> {
  await ensureHerdrProtocol();
  let inputs: Record<string, string> = {};
  let domains: Record<string, string[]> | undefined;
  if (opts.launchPayload) {
    let payload;
    try {
      payload = parseLaunchPayload(await Bun.stdin.text());
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
    if (payload.name !== name) {
      die(`launch payload name '${payload.name}' does not match run name '${name}'`);
    }
    inputs = payload.inputs;
    domains = payload.domains;
  }
  inputs = { ...inputs, ...opts.input };
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
      inputs,
      ...(domains !== undefined ? { domains } : {}),
      ...(opts.launchPayload ? { resolveDynamic: false } : {}),
      onProgress: (i, n, label, outcome = "ok") => {
        if (outcome === "start") {
          process.stdout.write(`[${i}/${n}] ${label}…\n`);
          return;
        }
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
  try {
    const proc = Bun.spawn(process.platform === "darwin" ? ["open", url] : ["xdg-open", url], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
    proc.unref();
  } catch {
    /* opener absence is nonfatal — the printed URL still reaches the caller */
  }
}

function printWorkbenchUrl(url: string): void {
  try {
    process.stdout.write(`herdr-workflows web · ${url}\n`);
  } catch {
    /* EPIPE when a detached launcher's inherited PTY is already gone */
  }
}

function registerOwnedWorkbenchShutdown(shutdown: () => void): void {
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function cmdWeb(
  routeRaw: string | undefined,
  opts: { port?: number; open?: boolean },
): Promise<void> {
  const port = opts.port;
  const route = routeRaw === undefined ? undefined : parseWebRoute(routeRaw);
  if (routeRaw !== undefined && !route) {
    die(
      `web route expects w=<repo|global>:<name>, share=<repo|global>:<name>, or import, got '${routeRaw}'`,
    );
  }
  const repoRoot = process.env.HERDR_WORKFLOWS_REPO_ROOT || (await resolveRepoRoot());
  const workbench = await ensureWorkbench({ repoRoot, port });
  const url = appendRouteHash(workbench.url, route);
  // Open before printing: a detached picker handoff can already have a dead
  // stdout, and SIGPIPE on write must not skip the browser.
  if (opts.open !== false) openBrowser(url);
  printWorkbenchUrl(url);
  if (!workbench.owned) return;
  const shutdown = () => {
    workbench.stop();
    process.exit(0);
  };
  registerOwnedWorkbenchShutdown(shutdown);
  // Adoption trusts any endpoint that answers a probe, so a workbench outliving its own build
  // would keep serving the previous one to every picker action.
  retireOnCodeChange(shutdown);
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
  // Concurrent with config/workflow loading — never awaited before mount.
  const { defaultPickerReleaseCheck } = await import("./tui/update-indicator");
  const releaseCheck = defaultPickerReleaseCheck();
  const config = await loadConfig(root);
  const entries = await listWorkflows(root, config);
  if (!picker.hasVisibleEntries(entries)) die("no workflows found");

  ctx.cwd = root;
  const code = await picker.runPickerSession({
    entries,
    repoRoot: root,
    config,
    ctx,
    checkLatestRelease: () => releaseCheck,
  });
  process.exit(code);
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("hwf")
    .description(manifest.description)
    .version(manifest.version)
    .addHelpText("after", `\nWorkflow format: ${WORKFLOW_FORMAT}`);

  program
    .command("run")
    .description("Run a workflow by name")
    .argument("<name>", "workflow name")
    .option("--input <name=value>", "workflow input (repeatable)", collectInput, {})
    .option("--launch-payload", "read launch payload JSON from stdin")
    .action(
      async (name: string, opts: { input?: Record<string, string>; launchPayload?: boolean }) => {
        await cmdRun(name, opts);
      },
    );

  program
    .command("init")
    .description("Write local or global plugin config")
    .option("--force", "overwrite existing config without prompting")
    .option("--global", "write global plugin config")
    .action(async (opts: { force?: boolean; global?: boolean }) => {
      await cmdInit(opts);
    });

  const workflow = program.command("workflow").description("Workflow maintenance commands");
  workflow
    .command("import")
    .description("Import a shared workflow bundle")
    .argument("<payload>", "base64 workflow bundle")
    .addOption(new Option("--to <scope>", "repo or global destination").choices(["repo", "global"]))
    .option("-y, --yes", "skip interactive confirmation")
    .option("--force", "replace conflicting workflows")
    .action(
      async (payload: string, opts: { to?: "repo" | "global"; yes?: boolean; force?: boolean }) => {
        await cmdWorkflowImport(payload, opts);
      },
    );
  workflow
    .command("inspect")
    .description("Print workflow input metadata")
    .argument("<name>", "workflow name")
    .option("--input <name=value>", "select guarded input path (repeatable)", collectInput, {})
    .option("--resolve", "resolve active dynamic choices")
    .action(async (name: string, opts: { input?: Record<string, string>; resolve?: boolean }) => {
      await cmdWorkflowInspect(name, opts);
    });

  program
    .command("launch")
    .description("Open the workflow picker popup")
    .action(async () => {
      await cmdLaunch();
    });

  program
    .command("picker")
    .description("Run the picker TUI (plugin popup entrypoint)")
    .action(async () => {
      await ensureHerdrProtocol();
      preferOnDiskOpentuiLib();
      await runPickerPopup(await import("./tui/picker"));
    });

  program
    .command("web")
    .description("Start the browser workbench")
    .argument("[route]", "optional w=|share=|import route")
    .option("--port <integer>", "listen port", parsePort)
    .option("--no-open", "do not open a browser")
    .action(async (route: string | undefined, opts: { port?: number; open?: boolean }) => {
      await cmdWeb(route, opts);
    });

  program
    .command("update")
    .description("Update to the latest published GitHub Release via Herdr")
    .action(async () => {
      await runUpdate();
    });

  program
    .command("setup", { hidden: true })
    .description("Install PATH commands and picker keybindings")
    .action(() => {
      runSetup();
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // Bare TTY → web. A root `.action()` disables implicit `help` and turns unknown
  // tokens into excess-argument errors, so keep subcommand dispatch stock.
  const args = process.argv.slice(2);
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    args.push("web");
  }
  await program.parseAsync(args, { from: "user" });
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
