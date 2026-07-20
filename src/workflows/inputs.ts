import { WorkflowLoadError, positioned, type FlatStep, type InputSpec } from "./errors";
import type { RawWorkflow } from "./parse";
import { paramsInputRefs, textInputRefs } from "./substitute";

export const AGENT_INPUT_RE = /^\{input\.([a-z][a-z0-9_]{0,31})\}$/;

export function resolveInputs(file: string, raw: RawWorkflow, agents: Set<string>): InputSpec[] {
  const specs: InputSpec[] = [];
  for (const [name, input] of Object.entries(raw.inputs ?? {})) {
    let options: string[] | undefined;
    if (input.options === "agents") {
      if (agents.size === 0) {
        throw new WorkflowLoadError(
          positioned(file, undefined, `inputs.${name}`, "options: agents but no agents configured"),
        );
      }
      options = [...agents];
    } else {
      options = input.options;
    }
    if (options && input.default !== undefined && !options.includes(input.default)) {
      throw new WorkflowLoadError(
        positioned(file, undefined, `inputs.${name}`, `default '${input.default}' not in options`),
      );
    }
    specs.push({ name, label: input.label ?? name, options, default: input.default });
  }
  return specs;
}

function checkAgentInput(file: string, idx: number, spec: InputSpec, agents: Set<string>): void {
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

/** Validate every {input.*} reference against declared inputs; returns the used input names. */
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
