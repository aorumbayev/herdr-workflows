import { spawnCapture } from "../runner/shell";
import { WorkflowLoadError, positioned, type FlatStep, type InputSpec } from "./errors";
import type { RawWorkflow } from "./parse";
import { paramsInputRefs, textInputRefs } from "./substitute";

export const AGENT_INPUT_RE = /^\{input\.([a-z][a-z0-9_]{0,31})\}$/;

const OPTIONS_CMD_TIMEOUT_MS = 5_000;
const AGENTS_BUILTIN = "agents";

async function resolveOptionLines(
  file: string,
  inputName: string,
  command: string,
  repoRoot: string,
): Promise<string[]> {
  const result = await spawnCapture(["sh", "-c", command], {
    cwd: repoRoot,
    timeoutMs: OPTIONS_CMD_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new WorkflowLoadError(
      positioned(
        file,
        undefined,
        `inputs.${inputName}`,
        `options command timed out after ${OPTIONS_CMD_TIMEOUT_MS / 1000}s`,
      ),
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    throw new WorkflowLoadError(
      positioned(file, undefined, `inputs.${inputName}`, `options command failed: ${detail}`),
    );
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new WorkflowLoadError(
      positioned(file, undefined, `inputs.${inputName}`, "options command produced no choices"),
    );
  }
  return lines;
}

export async function resolveInputs(
  file: string,
  raw: RawWorkflow,
  agents: Set<string>,
  repoRoot: string,
  resolveDynamic = true,
): Promise<InputSpec[]> {
  const specs: InputSpec[] = [];
  for (const [name, input] of Object.entries(raw.inputs ?? {})) {
    let options: string[] | undefined;
    if (input.options === undefined) {
      options = undefined;
    } else if (Array.isArray(input.options)) {
      options = input.options;
    } else if (input.options === AGENTS_BUILTIN) {
      if (agents.size === 0) {
        throw new WorkflowLoadError(
          positioned(file, undefined, `inputs.${name}`, "options: agents but no agents configured"),
        );
      }
      options = [...agents];
    } else if (resolveDynamic) {
      options = await resolveOptionLines(file, name, input.options, repoRoot);
    }
    if (options && input.default !== undefined && !options.includes(input.default)) {
      throw new WorkflowLoadError(
        positioned(file, undefined, `inputs.${name}`, `default '${input.default}' not in options`),
      );
    }
    const dynamicOptions =
      typeof input.options === "string" && input.options !== AGENTS_BUILTIN && !resolveDynamic;
    specs.push({
      name,
      label: input.label ?? name,
      options,
      ...(dynamicOptions ? { dynamicOptions: true } : {}),
      default: input.default,
    });
  }
  return specs;
}

function checkAgentInput(file: string, idx: number, spec: InputSpec, agents: Set<string>): void {
  if (spec.dynamicOptions) return;
  if (!spec.options) {
    throw new WorkflowLoadError(
      positioned(file, idx + 1, "agent", `input '${spec.name}' needs options: to be used as agent`),
    );
  }
  for (const option of spec.options) {
    if (!agents.has(option)) {
      throw new WorkflowLoadError(
        positioned(
          file,
          idx + 1,
          "agent",
          `input '${spec.name}' option '${option}' is not a config agent`,
        ),
      );
    }
  }
}

export function checkInputRefs(
  file: string,
  inputs: Map<string, InputSpec>,
  steps: FlatStep[],
  agents: Set<string>,
): Set<string> {
  const used = new Set<string>();
  const require = (name: string, idx: number, key: string | undefined): InputSpec => {
    const spec = inputs.get(name);
    if (!spec) {
      throw new WorkflowLoadError(
        positioned(
          file,
          idx + 1,
          key,
          `undeclared input '{input.${name}}' — declare it under inputs:`,
        ),
      );
    }
    used.add(name);
    return spec;
  };
  steps.forEach((step, idx) => {
    if (step.verb === "shell") {
      for (const name of textInputRefs(step.stdin ?? "")) require(name, idx, "stdin");
      for (const name of inputs.keys()) {
        if (step.command.includes(`HWF_INPUT_${name}`)) require(name, idx, undefined);
      }
      return;
    }
    if (step.verb === "herdr") {
      for (const name of paramsInputRefs(step.params)) require(name, idx, "params");
      return;
    }
    if (step.verb !== "agent") return;
    for (const name of textInputRefs(step.prompt ?? "")) require(name, idx, "prompt");
    const m = AGENT_INPUT_RE.exec(step.name);
    if (m) checkAgentInput(file, idx, require(m[1]!, idx, "agent"), agents);
  });
  return used;
}
