import {
  globalConfigPath,
  noProfilesConfiguredMessage,
  profileNames,
  repoConfigPath,
  type WorkflowsConfig,
} from "../config";
import { evaluateWhen } from "./conditions";
import { resolveDynamicChoices } from "./load";
import type { InputSpec, LoadedWorkflow, TemplateNamespace } from "./types";

export type CollectedInputs =
  | { ok: true; values: Record<string, string>; domains: Record<string, string[]> }
  | { ok: false; error: string };

export type CollectInputsOpts = {
  specs: InputSpec[];
  provided?: Record<string, string>;
  /** Pre-resolved dynamic domains from picker launch payload. */
  domains?: Record<string, string[]>;
  config: WorkflowsConfig;
  repoRoot: string;
  file: string;
  /** Resolve dynamic choices that lack a supplied domain snapshot. */
  resolveDynamic?: boolean;
};

function optionsForSpec(spec: InputSpec, domains: Record<string, string[]>): string[] | undefined {
  if (domains[spec.name]) return domains[spec.name];
  if (spec.options) return spec.options;
  return undefined;
}

async function resolveActiveOptions(
  spec: InputSpec,
  opts: CollectInputsOpts,
  domains: Record<string, string[]>,
): Promise<{ ok: true; options?: string[] } | { ok: false; error: string }> {
  if (spec.type === "profile") {
    const profiles = profileNames(opts.config);
    if (profiles.length === 0) {
      return {
        ok: false,
        error: `input '${spec.name}': ${noProfilesConfiguredMessage(
          await globalConfigPath(),
          repoConfigPath(opts.repoRoot),
        )}`,
      };
    }
    return { ok: true, options: profiles };
  }
  if (spec.type !== "choice") return { ok: true };
  const existing = optionsForSpec(spec, domains);
  if (existing) return { ok: true, options: existing };
  if (!spec.dynamicOptions) {
    return { ok: false, error: `input '${spec.name}': choice produced no options` };
  }
  if (opts.resolveDynamic === false) {
    return {
      ok: false,
      error: `input '${spec.name}': missing launch payload domain snapshot`,
    };
  }
  try {
    const options = await resolveDynamicChoices(
      opts.file,
      spec.name,
      spec.dynamicOptions,
      opts.repoRoot,
    );
    domains[spec.name] = options;
    return { ok: true, options };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function validateActiveValue(
  spec: InputSpec,
  value: string,
  options: string[] | undefined,
): string | undefined {
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    return `input '${spec.name}' must be at least ${spec.minLength} characters`;
  }
  if (spec.type === "profile") {
    if (!options?.includes(value)) {
      return `input '${spec.name}' must be one of: ${(options ?? []).join(", ")}`;
    }
    return undefined;
  }
  if (spec.type === "choice" && options) {
    if (!spec.allowCustom && !options.includes(value)) {
      return `input '${spec.name}' must be one of: ${options.join(", ")}`;
    }
  }
  return undefined;
}

/**
 * Sequential input collection shared by entry CLI, picker, and child workflows.
 * Skips inactive inputs, resolves active dynamic choices at most once, and rejects
 * supplied values for inactive inputs.
 */
export async function collectInputValues(opts: CollectInputsOpts): Promise<CollectedInputs> {
  const provided = opts.provided ?? {};
  const domains: Record<string, string[]> = { ...opts.domains };
  const declared = new Set(opts.specs.map((spec) => spec.name));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) return { ok: false, error: `unknown input '${name}'` };
  }
  for (const name of Object.keys(domains)) {
    const spec = opts.specs.find((row) => row.name === name);
    if (!spec || spec.type !== "choice" || !spec.dynamicOptions) {
      return {
        ok: false,
        error: `launch payload domain '${name}' must name a declared dynamic choice input`,
      };
    }
  }

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const ns: TemplateNamespace = { inputs: values, steps: {}, context: {} };
  const usedDomains = new Set<string>();

  for (const spec of opts.specs) {
    const active = evaluateWhen(spec.when, ns);
    const supplied = Object.hasOwn(provided, spec.name);
    if (!active) {
      if (supplied) {
        return {
          ok: false,
          error: `input '${spec.name}' is inactive under current answers`,
        };
      }
      continue;
    }

    if (Object.hasOwn(domains, spec.name)) usedDomains.add(spec.name);

    const resolved = await resolveActiveOptions(spec, opts, domains);
    if (!resolved.ok) return resolved;
    if (resolved.options !== undefined && resolved.options.length === 0) {
      return {
        ok: false,
        error:
          spec.type === "profile"
            ? `input '${spec.name}': no profiles configured; run \`hwf init\` or \`hwf init --global\``
            : `input '${spec.name}': choice produced no options`,
      };
    }

    const value = supplied ? provided[spec.name]! : spec.default;
    if (value === undefined) {
      return { ok: false, error: `missing input '${spec.name}' (--input ${spec.name}=…)` };
    }
    const err = validateActiveValue(spec, value, resolved.options);
    if (err) return { ok: false, error: err };
    values[spec.name] = value;
  }

  for (const name of Object.keys(opts.domains ?? {})) {
    if (!usedDomains.has(name)) {
      return {
        ok: false,
        error: `launch payload domain '${name}' belongs to an inactive or non-dynamic input`,
      };
    }
  }

  return { ok: true, values, domains };
}

export async function collectWorkflowInputs(
  workflow: LoadedWorkflow,
  opts: Omit<CollectInputsOpts, "specs" | "file">,
): Promise<CollectedInputs> {
  return collectInputValues({
    ...opts,
    specs: workflow.inputs,
    file: workflow.file,
  });
}

/** Next active input given answers collected so far (picker incremental path). */
export function nextActiveInput(
  specs: InputSpec[],
  values: Record<string, string>,
  fromIndex = 0,
): { index: number; spec: InputSpec } | undefined {
  const ns: TemplateNamespace = { inputs: values, steps: {}, context: {} };
  for (let i = fromIndex; i < specs.length; i++) {
    const spec = specs[i]!;
    if (evaluateWhen(spec.when, ns)) return { index: i, spec };
  }
  return undefined;
}
