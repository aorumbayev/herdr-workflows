import { isResultDotPath, validateMethodParams } from "../herdr-methods";
import {
  WorkflowLoadError,
  positioned,
  type FlatStep,
  type OutSpec,
  type Placement,
} from "./types";
import type { RawStep } from "./parse";
import { COMPOSITE_KEYS, PLACEMENTS } from "./step-keys";
import {
  parseFor,
  parseGuard,
  parseOut,
  parseRetry,
  parseRunPayload,
  parseWait,
  rejectV1Placeholders,
} from "./step-modifiers";
import { findV1InputPlaceholder, paramsPlaceholders } from "./substitute";
import {
  flatNeedsInvokingAgent,
  flatNeedsPrompt,
  flatNeedsSession,
  stepReferencedNames,
} from "./step-refs";

export { flatNeedsInvokingAgent, flatNeedsPrompt, flatNeedsSession, stepReferencedNames };

export const AGENT_NAME_RE = /^\{([a-z][a-z0-9_]{0,31})\}$/;

function isMethodKey(key: string): boolean {
  return key.includes(".") && !key.includes(" ");
}

function actionKeyOf(step: RawStep): string {
  const keys = Object.keys(step).filter(
    (k) => (COMPOSITE_KEYS as readonly string[]).includes(k) || isMethodKey(k),
  );
  return keys[0]!;
}

function placementOf(action: string, step: RawStep): Placement {
  if (typeof step.in === "string" && (PLACEMENTS as readonly string[]).includes(step.in)) {
    return step.in as Placement;
  }
  return action === "agent" ? "tab" : "here";
}

function outNames(out: OutSpec | undefined): string[] {
  if (!out) return [];
  if (out.kind === "text") return [out.name];
  return Object.keys(out.fields);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function envMap(step: RawStep): Record<string, string> | undefined {
  return step.env && typeof step.env === "object" && !Array.isArray(step.env)
    ? (step.env as Record<string, string>)
    : undefined;
}

function flatRun(file: string, stepIndex: number, step: RawStep, out: OutSpec | undefined) {
  const payload = parseRunPayload(file, stepIndex, step);
  const place = placementOf("run", step);
  if (out?.kind === "map" && place === "here") {
    throw new WorkflowLoadError(
      positioned(
        file,
        stepIndex,
        "out",
        "map out: requires a placed run: or a primitive with a structured result",
      ),
    );
  }
  if (out?.kind === "text" && place !== "here") {
    throw new WorkflowLoadError(
      positioned(
        file,
        stepIndex,
        "out",
        "identifier out: on a placed run: is invalid — use map form { tab: tab_id, … }",
      ),
    );
  }
  return {
    kind: "run" as const,
    payload,
    in: place,
    cwd: typeof step.cwd === "string" ? step.cwd : undefined,
    env: envMap(step),
    ratio: typeof step.ratio === "number" ? step.ratio : undefined,
  };
}

function flatAgent(file: string, stepIndex: number, step: RawStep, out: OutSpec | undefined) {
  if (typeof step.agent !== "string" || !step.agent) {
    throw new WorkflowLoadError(positioned(file, stepIndex, "agent", "agent: value is required"));
  }
  rejectV1Placeholders(file, stepIndex, "agent", step.agent);
  if (typeof step.prompt === "string") rejectV1Placeholders(file, stepIndex, "prompt", step.prompt);
  if (out?.kind === "map") {
    throw new WorkflowLoadError(
      positioned(file, stepIndex, "out", "agent: produces text — use identifier out: form"),
    );
  }
  return {
    kind: "agent" as const,
    agent: step.agent,
    prompt: typeof step.prompt === "string" ? step.prompt : undefined,
    in: placementOf("agent", step),
    cwd: typeof step.cwd === "string" ? step.cwd : undefined,
    env: envMap(step),
    ratio: typeof step.ratio === "number" ? step.ratio : undefined,
  };
}

function flatPrimitive(
  file: string,
  stepIndex: number,
  method: string,
  step: RawStep,
  out: OutSpec | undefined,
) {
  const params =
    step[method] === null || step[method] === undefined
      ? undefined
      : typeof step[method] === "object" && !Array.isArray(step[method])
        ? (step[method] as Record<string, unknown>)
        : undefined;
  if (step[method] !== null && step[method] !== undefined && params === undefined) {
    throw new WorkflowLoadError(
      positioned(file, stepIndex, method, "primitive value must be a params object"),
    );
  }
  const err = validateMethodParams(method, params);
  if (err) throw new WorkflowLoadError(positioned(file, stepIndex, method, err));
  if (params) {
    for (const name of paramsPlaceholders(params)) {
      if (name === "last") {
        throw new WorkflowLoadError(
          positioned(
            file,
            stepIndex,
            method,
            `'{last}' is removed — bind a named out: on the producing step`,
          ),
        );
      }
    }
    for (const text of collectStrings(params)) {
      const v1 = findV1InputPlaceholder(text);
      if (v1) {
        throw new WorkflowLoadError(
          positioned(file, stepIndex, method, `'{input.${v1}}' is removed — use {${v1}}`),
        );
      }
    }
  }
  if (out?.kind === "text") {
    throw new WorkflowLoadError(
      positioned(file, stepIndex, "out", "primitive steps require map-form out: (name: dot.path)"),
    );
  }
  if (out?.kind === "map") {
    for (const [name, path] of Object.entries(out.fields)) {
      if (!isResultDotPath(path)) {
        throw new WorkflowLoadError(
          positioned(file, stepIndex, "out", `out.${name}: unresolvable result path '${path}'`),
        );
      }
    }
  }
  return { kind: "primitive" as const, method, params };
}

export function rawToFlat(file: string, stepIndex: number, step: RawStep): FlatStep {
  const action = actionKeyOf(step);
  const wait = parseWait(file, stepIndex, step.wait);
  const out = step.out !== undefined ? parseOut(file, stepIndex, step.out) : undefined;
  const when = step.when !== undefined ? parseGuard(file, stepIndex, "when", step.when) : undefined;
  const forSource = step.for !== undefined ? parseFor(file, stepIndex, step.for) : undefined;
  if (step.as !== undefined) {
    if (!forSource) {
      throw new WorkflowLoadError(positioned(file, stepIndex, "as", "as: requires for:"));
    }
    if (typeof step.as !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(step.as)) {
      throw new WorkflowLoadError(
        positioned(file, stepIndex, "as", "as: must match [a-z][a-z0-9_]{0,31}"),
      );
    }
  }
  const retry = step.retry !== undefined ? parseRetry(file, stepIndex, step.retry) : undefined;
  const timeoutMs = typeof step.timeout === "number" ? step.timeout * 1000 : undefined;

  let flatAction: FlatStep["action"];
  if (action === "run") flatAction = flatRun(file, stepIndex, step, out);
  else if (action === "agent") flatAction = flatAgent(file, stepIndex, step, out);
  else if (action === "use") {
    throw new WorkflowLoadError(
      positioned(file, stepIndex, "use", "internal: use: must be flattened before rawToFlat"),
    );
  } else flatAction = flatPrimitive(file, stepIndex, action, step, out);

  if (retry) {
    const createsPane =
      flatAction.kind === "agent" || (flatAction.kind === "run" && flatAction.in !== "here");
    if (createsPane && !retry.reset) {
      throw new WorkflowLoadError(
        positioned(
          file,
          stepIndex,
          "retry",
          "retry: on a pane-creating step requires reset: — herdr has no create-or-return-by-key method, so attempt 2 would strand attempt 1's pane; put the close in reset:",
        ),
      );
    }
  }

  return {
    name: typeof step.name === "string" ? step.name : undefined,
    action: flatAction,
    out,
    when,
    for: forSource,
    as: typeof step.as === "string" ? step.as : undefined,
    retry,
    wait,
    timeoutMs,
    allowFail: step.allow_fail === true ? true : undefined,
  };
}

export function stepOutNames(step: FlatStep): string[] {
  return outNames(step.out);
}

export function checkAgents(file: string, steps: FlatStep[], agents: Set<string>): void {
  const walk = (list: FlatStep[], baseIndex: number) => {
    list.forEach((step, idx) => {
      if (step.action.kind === "include") {
        walk(step.action.steps, baseIndex);
        return;
      }
      if (step.action.kind !== "agent") return;
      const name = step.action.agent;
      if (name === "{agent}") return;
      if (AGENT_NAME_RE.test(name)) return;
      if (!agents.has(name)) {
        throw new WorkflowLoadError(
          positioned(file, baseIndex + idx + 1, "agent", `unknown agent '${name}'`),
        );
      }
    });
  };
  walk(steps, 0);
}
