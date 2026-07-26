import { HerdrError } from "../adapter/rpc";
import { fillAgentArgv } from "../config";
import { HERDR_METHOD_BY_NAME } from "../herdr-methods.generated";
import { PANE_READ_LINES, PANE_READ_SOURCE } from "../pane-read";
import type { FlatStep, PlaceholderValues } from "../workflows/types";
import { substitute, substituteParams } from "../workflows/substitute";
import { AGENT_NAME_RE } from "../workflows/inputs";
import { waitAgentDone } from "./agent-wait";
import { placeCommand } from "./place";
import { shellArgv } from "./shell";
import type { RunnerDeps, StepRunOptions } from "./types";

export type FireOutcome = {
  failed?: { ok: false; error: string };
  text?: string;
  bindings?: Record<string, string>;
  result?: Record<string, unknown>;
};

const INVOKING_AGENT = "{agent}";

export async function fail(
  deps: RunnerDeps,
  workflow: string,
  step: number,
  detail: string,
): Promise<string> {
  const text = `step ${step}: ${detail}`;
  const body = text.length > 500 ? `…${text.slice(-500)}` : text;
  await deps.notificationShow(`herdr-workflows: ${workflow} failed`, body).catch(() => undefined);
  return body;
}

function autofill(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: StepRunOptions["ctx"],
): Record<string, unknown> {
  const out = { ...params };
  const props = HERDR_METHOD_BY_NAME.get(method)?.params.properties ?? {};
  if (out.pane_id === undefined && ctx.paneId && props.pane_id) out.pane_id = ctx.paneId;
  if (out.tab_id === undefined && ctx.tabId && props.tab_id) out.tab_id = ctx.tabId;
  if (out.workspace_id === undefined && ctx.workspaceId && props.workspace_id) {
    out.workspace_id = ctx.workspaceId;
  }
  return out;
}

function resolveAgentName(stepName: string, values: PlaceholderValues): string {
  if (stepName === INVOKING_AGENT) return values.agent ?? "";
  const m = AGENT_NAME_RE.exec(stepName);
  return m ? (values[m[1]!] ?? "") : stepName;
}

function commandArgv(
  step: FlatStep & { action: { kind: "run" } },
  values: PlaceholderValues,
): string[] {
  const payload = step.action.payload;
  if (payload.form === "argv") return payload.argv.map((el) => substitute(el, values));
  return shellArgv(payload.command, payload.shell);
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function bindOutMap(
  fields: Record<string, string>,
  result: Record<string, unknown>,
): { ok: true; bindings: Record<string, string> } | { ok: false; error: string } {
  const bindings: Record<string, string> = {};
  for (const [name, path] of Object.entries(fields)) {
    const value = readPath(result, path);
    if (value === undefined) {
      const type = typeof result.type === "string" ? result.type : "unknown";
      return { ok: false, error: `out.${name}: path '${path}' missing on result.type '${type}'` };
    }
    bindings[name] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return { ok: true, bindings };
}

function substituteEnv(
  env: Record<string, string> | undefined,
  values: PlaceholderValues,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, substitute(v, values)]));
}

function resolveRunEnv(
  step: FlatStep & { action: { kind: "run" } },
  opts: StepRunOptions,
  values: PlaceholderValues,
  env: NodeJS.ProcessEnv,
): { cwd: string; mergedEnv: NodeJS.ProcessEnv; stepEnv?: Record<string, string> } {
  const cwd = step.action.cwd !== undefined ? substitute(step.action.cwd, values) : opts.ctx.cwd;
  const stepEnv = substituteEnv(step.action.env, values);
  return { cwd, stepEnv, mergedEnv: { ...env, ...stepEnv } };
}

async function withOutMap(
  opts: StepRunOptions,
  n: number,
  out: FlatStep["out"],
  result: Record<string, unknown>,
): Promise<FireOutcome> {
  if (out?.kind !== "map") return { result };
  const bound = bindOutMap(out.fields, result);
  if (!bound.ok) {
    return { failed: { ok: false, error: await fail(opts.deps, opts.name, n, bound.error) } };
  }
  return { bindings: bound.bindings, result };
}

async function fireRun(
  opts: StepRunOptions,
  step: FlatStep & { action: { kind: "run" } },
  values: PlaceholderValues,
  n: number,
  env: NodeJS.ProcessEnv,
): Promise<FireOutcome> {
  const place = step.action.in;
  const { cwd, mergedEnv, stepEnv } = resolveRunEnv(step, opts, values, env);

  if (place === "here") {
    const payload = step.action.payload;
    const result =
      payload.form === "argv"
        ? await opts.deps.runArgv(
            payload.argv.map((el) => substitute(el, values)),
            { cwd, env: mergedEnv, timeoutMs: step.timeoutMs },
          )
        : await opts.deps.runShell(payload.command, {
            cwd,
            env: mergedEnv,
            timeoutMs: step.timeoutMs,
            shell: payload.shell,
          });
    if (result.stderr) opts.onStderr?.(result.stderr);
    if (!result.ok) {
      return {
        failed: {
          ok: false,
          error: await fail(opts.deps, opts.name, n, result.stderr.trim() || "nonzero exit"),
        },
      };
    }
    const bindings: Record<string, string> = {};
    if (step.out?.kind === "text") bindings[step.out.name] = result.stdout;
    return { text: result.stdout, bindings };
  }

  const label =
    step.name ??
    (step.action.payload.form === "argv"
      ? step.action.payload.argv[0] || "run"
      : step.action.payload.command.split(/\s+/)[0] || "run");
  const argv = commandArgv(step, values);
  const applied = await placeCommand(opts, place, argv, label, cwd, stepEnv, step.action.ratio);

  if (step.wait.kind === "detach") {
    return {
      bindings: step.out?.kind === "map" ? undefined : undefined,
      result: { tab_id: applied.tabId, pane_id: applied.paneId, workspace_id: applied.workspaceId },
    };
  }
  if (step.wait.kind === "regex") {
    await opts.deps.waitOutput(applied.paneId, step.wait.pattern, step.timeoutMs ?? 60_000);
  } else {
    // block: no pane process-wait API; treat placement success as completion unless regex/detach
  }

  return withOutMap(opts, n, step.out, {
    tab_id: applied.tabId,
    pane_id: applied.paneId,
    workspace_id: applied.workspaceId,
    type: "layout",
    layout: {
      tab_id: applied.tabId,
      focused_pane_id: applied.paneId,
      workspace_id: applied.workspaceId,
    },
  });
}

async function fireAgent(
  opts: StepRunOptions,
  step: FlatStep & { action: { kind: "agent" } },
  values: PlaceholderValues,
  n: number,
): Promise<FireOutcome> {
  const name = resolveAgentName(step.action.agent, values);
  if (step.action.agent === INVOKING_AGENT && !name) {
    return {
      failed: {
        ok: false,
        error: await fail(
          opts.deps,
          opts.name,
          n,
          "invoking agent unresolved — run from agent pane",
        ),
      },
    };
  }
  const template = opts.agents[name];
  if (!template) {
    return {
      failed: {
        ok: false,
        error: await fail(opts.deps, opts.name, n, `unknown agent '${name}'`),
      },
    };
  }
  const prompt = step.action.prompt !== undefined ? substitute(step.action.prompt, values) : "";
  const cwd = step.action.cwd !== undefined ? substitute(step.action.cwd, values) : opts.ctx.cwd;
  const stepEnv = substituteEnv(step.action.env, values);
  const place = step.action.in;
  const applied = await placeCommand(
    opts,
    place === "here" ? "tab" : place,
    fillAgentArgv(template, prompt),
    name,
    cwd,
    stepEnv,
    step.action.ratio,
  );

  if (step.wait.kind === "detach") {
    return { result: { tab_id: applied.tabId, pane_id: applied.paneId } };
  }
  if (step.wait.kind === "regex") {
    await opts.deps.waitOutput(applied.paneId, step.wait.pattern, step.timeoutMs ?? 1_800_000);
  } else {
    await waitAgentDone(applied.paneId, step.timeoutMs ?? 1_800_000, {
      agentStatus: opts.deps.agentStatus,
      sleep: opts.deps.sleep ?? ((ms) => Bun.sleep(ms)),
      now: opts.deps.now,
      pollMs: opts.deps.agentWaitPollMs,
      idleGraceMs: opts.deps.agentWaitIdleGraceMs,
      onBlocked: () =>
        opts.deps.notificationShow(
          `herdr-workflows: ${opts.name} waiting`,
          `agent blocked on step ${n} — needs your input`,
        ),
    });
  }
  const text = (
    await opts.deps.paneRead(applied.paneId, {
      source: PANE_READ_SOURCE,
      lines: PANE_READ_LINES,
    })
  ).trim();
  const bindings: Record<string, string> = {};
  if (step.out?.kind === "text") bindings[step.out.name] = text;
  return { text, bindings };
}

async function firePrimitive(
  opts: StepRunOptions,
  step: FlatStep & { action: { kind: "primitive" } },
  values: PlaceholderValues,
  n: number,
): Promise<FireOutcome> {
  const params = autofill(
    step.action.method,
    substituteParams(step.action.params, values),
    opts.ctx,
  );
  const result = (await opts.deps.herdrCall(step.action.method, params)) as Record<string, unknown>;
  return withOutMap(opts, n, step.out, result);
}

export async function fire(
  opts: StepRunOptions,
  step: FlatStep,
  values: PlaceholderValues,
  n: number,
  env: NodeJS.ProcessEnv,
): Promise<FireOutcome> {
  try {
    if (step.action.kind === "run") {
      return await fireRun(opts, step as FlatStep & { action: { kind: "run" } }, values, n, env);
    }
    if (step.action.kind === "agent") {
      return await fireAgent(opts, step as FlatStep & { action: { kind: "agent" } }, values, n);
    }
    if (step.action.kind === "primitive") {
      return await firePrimitive(
        opts,
        step as FlatStep & { action: { kind: "primitive" } },
        values,
        n,
      );
    }
    return {
      failed: {
        ok: false,
        error: await fail(opts.deps, opts.name, n, "internal: include must be handled by dispatch"),
      },
    };
  } catch (error) {
    const detail =
      error instanceof HerdrError || error instanceof Error ? error.message : String(error);
    return { failed: { ok: false, error: await fail(opts.deps, opts.name, n, detail) } };
  }
}
