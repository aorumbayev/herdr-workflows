import type { FlatStep, Guard, PlaceholderValues } from "../workflow/types";
import { substitute } from "../workflow/parse";
import type { StepRunOptions } from "./types";

const FOR_CAP = 100;

export async function evalGuard(
  guard: Guard,
  values: PlaceholderValues,
  opts: StepRunOptions,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (guard.kind === "nonempty") {
    const v = values[guard.name] ?? "";
    const nonempty = v.length > 0;
    return guard.negate ? !nonempty : nonempty;
  }
  if (guard.kind === "argv") {
    const argv = guard.argv.map((el) => substitute(el, values));
    const result = await opts.deps.runArgv(argv, { cwd: opts.ctx.cwd, env });
    return result.ok;
  }
  const result = await opts.deps.runShell(guard.command, { cwd: opts.ctx.cwd, env });
  return result.ok;
}

export async function resolveForItems(
  step: FlatStep,
  values: PlaceholderValues,
  opts: StepRunOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; items: string[] } | { ok: false; error: string }> {
  if (!step.for) return { ok: true, items: [""] };
  let items: string[];
  if (step.for.kind === "list") items = step.for.items;
  else if (step.for.kind === "binding") {
    items = (values[step.for.name] ?? "").split("\n").filter((l) => l.length > 0);
  } else {
    const result = await opts.deps.runShell(step.for.command, { cwd: opts.ctx.cwd, env });
    if (!result.ok) {
      return { ok: false, error: result.stderr.trim() || "for: command failed" };
    }
    items = result.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  }
  if (items.length > FOR_CAP) {
    return {
      ok: false,
      error: `for: resolved ${items.length} items — cap is ${FOR_CAP}`,
    };
  }
  return { ok: true, items };
}

export function bindSkippedOuts(step: FlatStep, values: PlaceholderValues): void {
  if (!step.out) return;
  if (step.out.kind === "text") {
    values[step.out.name] = "";
    return;
  }
  for (const name of Object.keys(step.out.fields)) values[name] = "";
}
