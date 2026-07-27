import { RESULT_DOT_PATHS } from "../herdr-methods";
import { isWholeValueTemplate, parseTemplatePath, stepTemplates, textTemplates } from "./parse";
import {
  bail,
  IDENT_RE,
  type InputSpec,
  type LoadedWorkflow,
  type ReturnsSpec,
  type TemplatePath,
  type WorkflowStep,
} from "./types";

type ProducerKind = "agent" | "command" | "readiness" | "herdr" | "child" | "none";

export type StepProducer = {
  id: string;
  index: number;
  kind: ProducerKind;
  herdrMethod?: string;
  childReturns?: ReturnsSpec;
  noneReason?: string;
};

type SourceType = "string" | "number" | "boolean" | "object" | "unknown";

const COMMAND_FIELDS = new Set(["stdout", "stderr", "exit_code", "failed"]);
const AGENT_STRING_FIELDS = new Set(["response", "pane_id"]);
const READINESS_ID_FIELDS = new Set(["pane_id", "tab_id", "workspace_id"]);
const CONTEXT_STRING_FIELDS = new Set([
  "workspace",
  "tab",
  "pane",
  "worktree",
  "agent",
  "selection",
  "platform",
  "transcript",
  "transcript_file",
]);
const CONTEXT_ERROR_STRING = new Set(["message", "workflow", "action", "step_id"]);
const SENSITIVE_RETURNS = new Set(["transcript", "transcript_file"]);

function isLocalCommand(step: WorkflowStep): boolean {
  return step.action.kind === "run" && !step.action.pane && !step.action.background;
}

function isPlacedOrReady(step: WorkflowStep): boolean {
  return step.action.kind === "run" && (!!step.action.pane || !!step.action.readyWhen);
}

function classifyProducer(
  step: WorkflowStep,
  index: number,
  childReturns?: ReturnsSpec,
): StepProducer | undefined {
  if (!step.id) return undefined;
  const base = { id: step.id, index };

  if (step.when) {
    return { ...base, kind: "none", noneReason: "step may be skipped by when:" };
  }
  if ((step.action.kind === "run" || step.action.kind === "agent") && step.action.background) {
    return { ...base, kind: "none", noneReason: "background steps produce no result" };
  }

  if (step.continueOnError) {
    if (isLocalCommand(step)) return { ...base, kind: "command" };
    return {
      ...base,
      kind: "none",
      noneReason: "continue_on_error step may fail without a natural result",
    };
  }

  if (step.action.kind === "agent") return { ...base, kind: "agent" };
  if (step.action.kind === "herdr") {
    return { ...base, kind: "herdr", herdrMethod: step.action.method };
  }
  if (step.action.kind === "workflow") {
    if (!childReturns) {
      return {
        ...base,
        kind: "none",
        noneReason: "child workflow declares no returns:",
      };
    }
    return { ...base, kind: "child", childReturns };
  }
  if (step.action.kind === "run") {
    if (isPlacedOrReady(step)) return { ...base, kind: "readiness" };
    return { ...base, kind: "command" };
  }
  return { ...base, kind: "none", noneReason: "step produces no result" };
}

function assertUniqueStepIds(file: string, steps: WorkflowStep[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i]!.id;
    if (!id) continue;
    const index = i + 1;
    if (!IDENT_RE.test(id)) {
      bail(file, index, "id", "id must match [a-z][a-z0-9_]{0,31}");
    }
    const prev = seen.get(id);
    if (prev !== undefined) {
      bail(file, index, "id", `duplicate step id '${id}' (also step ${prev})`);
    }
    seen.set(id, index);
  }
}

function herdrFieldAllowed(fieldPath: string): boolean {
  if (RESULT_DOT_PATHS.has(fieldPath)) return true;
  const prefix = `${fieldPath}.`;
  for (const path of RESULT_DOT_PATHS) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function unknownField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  kind: string,
  producer: StepProducer,
  fieldSegments: string[],
): never {
  bail(
    file,
    stepIndex,
    key,
    `unknown ${kind} result field '${fieldSegments.join(".")}' on step '${producer.id}'`,
  );
}

function assertCommandField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  if (fieldSegments.length === 0) return;
  if (fieldSegments.length !== 1 || !COMMAND_FIELDS.has(fieldSegments[0]!)) {
    unknownField(file, stepIndex, key, "command", producer, fieldSegments);
  }
}

function assertAgentField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  if (fieldSegments.length === 0) return;
  const head = fieldSegments[0]!;
  if (AGENT_STRING_FIELDS.has(head)) {
    if (fieldSegments.length !== 1) {
      unknownField(file, stepIndex, key, "managed agent", producer, fieldSegments);
    }
    return;
  }
  if (head === "agent") {
    if (fieldSegments.length === 1) return;
    if (!herdrFieldAllowed(fieldSegments.join("."))) {
      unknownField(file, stepIndex, key, "managed agent", producer, fieldSegments);
    }
    return;
  }
  unknownField(file, stepIndex, key, "managed agent", producer, fieldSegments);
}

function assertReadinessField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  if (fieldSegments.length === 0) return;
  if (fieldSegments.length === 1 && READINESS_ID_FIELDS.has(fieldSegments[0]!)) return;
  if (!herdrFieldAllowed(fieldSegments.join("."))) {
    unknownField(file, stepIndex, key, "readiness", producer, fieldSegments);
  }
}

function assertHerdrField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  if (fieldSegments.length === 0) return;
  if (!herdrFieldAllowed(fieldSegments.join("."))) {
    unknownField(file, stepIndex, key, "herdr", producer, fieldSegments);
  }
}

function assertChildField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  const returns = producer.childReturns!;
  if (fieldSegments.length === 0) return;
  if (returns.kind === "template") return;
  const field = fieldSegments[0]!;
  if (!(field in returns.fields)) {
    bail(file, stepIndex, key, `unknown child return '${field}' on step '${producer.id}'`);
  }
}

function assertProducerField(
  file: string,
  stepIndex: number | undefined,
  key: string,
  producer: StepProducer,
  fieldSegments: string[],
): void {
  if (producer.kind === "none") {
    bail(
      file,
      stepIndex,
      key,
      `step '${producer.id}' produces no result (${producer.noneReason ?? "unavailable"})`,
    );
  }
  if (producer.kind === "command") {
    assertCommandField(file, stepIndex, key, producer, fieldSegments);
    return;
  }
  if (producer.kind === "agent") {
    assertAgentField(file, stepIndex, key, producer, fieldSegments);
    return;
  }
  if (producer.kind === "readiness") {
    assertReadinessField(file, stepIndex, key, producer, fieldSegments);
    return;
  }
  if (producer.kind === "herdr") {
    assertHerdrField(file, stepIndex, key, producer, fieldSegments);
    return;
  }
  assertChildField(file, stepIndex, key, producer, fieldSegments);
}

function assertContextPath(
  file: string,
  stepIndex: number | undefined,
  key: string,
  segments: string[],
): void {
  if (segments.length === 0) {
    bail(file, stepIndex, key, "context reference requires a field");
  }
  const head = segments[0]!;
  if (CONTEXT_STRING_FIELDS.has(head)) {
    if (segments.length !== 1) {
      bail(file, stepIndex, key, `unknown context path '${segments.join(".")}'`);
    }
    return;
  }
  if (head === "error") {
    if (segments.length === 1) return;
    const field = segments[1]!;
    if (CONTEXT_ERROR_STRING.has(field)) {
      if (segments.length !== 2) {
        bail(file, stepIndex, key, `unknown context path '${segments.join(".")}'`);
      }
      return;
    }
    if (field === "step_number") {
      if (segments.length !== 2) {
        bail(file, stepIndex, key, `unknown context path '${segments.join(".")}'`);
      }
      return;
    }
    if (field === "workflow_path" || field === "details") return;
    bail(file, stepIndex, key, `unknown context path '${segments.join(".")}'`);
  }
  bail(file, stepIndex, key, `unknown context path '${segments.join(".")}'`);
}

function sourceTypeOf(
  path: TemplatePath,
  producers: Map<string, StepProducer>,
  inputNames: Set<string>,
): SourceType {
  if (path.root === "inputs") {
    if (path.segments.length !== 1 || !inputNames.has(path.segments[0]!)) return "unknown";
    return "string";
  }
  if (path.root === "context") {
    const head = path.segments[0];
    if (!head) return "unknown";
    if (CONTEXT_STRING_FIELDS.has(head)) return path.segments.length === 1 ? "string" : "unknown";
    if (head === "error") {
      if (path.segments.length === 1) return "object";
      const field = path.segments[1]!;
      if (CONTEXT_ERROR_STRING.has(field)) return "string";
      if (field === "step_number") return "number";
      if (field === "workflow_path") return "object";
      if (field === "details") return path.segments.length === 2 ? "object" : "unknown";
    }
    return "unknown";
  }
  const id = path.segments[0];
  if (!id) return "unknown";
  const producer = producers.get(id);
  if (!producer || producer.kind === "none") return "unknown";
  const fields = path.segments.slice(1);
  if (fields.length === 0) return "object";
  if (producer.kind === "command") {
    const field = fields[0]!;
    if (field === "exit_code") return fields.length === 1 ? "number" : "unknown";
    if (field === "failed") return fields.length === 1 ? "boolean" : "unknown";
    if (field === "stdout" || field === "stderr") return fields.length === 1 ? "string" : "unknown";
    return "unknown";
  }
  if (producer.kind === "agent") {
    if (AGENT_STRING_FIELDS.has(fields[0]!) && fields.length === 1) return "string";
    if (fields[0] === "agent") return fields.length === 1 ? "object" : "unknown";
    return "unknown";
  }
  if (producer.kind === "child" && producer.childReturns?.kind === "map") {
    if (fields.length >= 1 && fields[0]! in producer.childReturns.fields) return "unknown";
  }
  return "unknown";
}

function assertTemplatePath(
  file: string,
  stepIndex: number | undefined,
  key: string,
  path: TemplatePath,
  opts: {
    producers: Map<string, StepProducer>;
    inputNames: Set<string>;
    earlierOnly: boolean;
    maxStepIndex?: number;
    rejectSensitiveContext?: boolean;
  },
): void {
  if (path.root === "inputs") {
    if (path.segments.length !== 1 || !opts.inputNames.has(path.segments[0]!)) {
      bail(file, stepIndex, key, `unknown input '${path.segments[0] ?? ""}'`);
    }
    return;
  }
  if (path.root === "context") {
    if (
      opts.rejectSensitiveContext &&
      path.segments[0] !== undefined &&
      SENSITIVE_RETURNS.has(path.segments[0])
    ) {
      bail(file, stepIndex, key, `returns: cannot reference context.${path.segments[0]}`);
    }
    assertContextPath(file, stepIndex, key, path.segments);
    return;
  }

  const id = path.segments[0];
  if (!id) {
    bail(file, stepIndex, key, "steps reference requires a step id");
  }
  const producer = opts.producers.get(id);
  if (!producer) {
    bail(file, stepIndex, key, `unknown step id '${id}'`);
  }
  if (opts.earlierOnly) {
    const max = opts.maxStepIndex ?? stepIndex;
    if (max !== undefined && producer.index >= max) {
      bail(file, stepIndex, key, `forward reference to step '${id}'`);
    }
  }
  assertProducerField(file, stepIndex, key, producer, path.segments.slice(1));
}

function assertTemplates(
  file: string,
  stepIndex: number | undefined,
  key: string,
  text: string,
  opts: {
    producers: Map<string, StepProducer>;
    inputNames: Set<string>;
    earlierOnly: boolean;
    maxStepIndex?: number;
    rejectSensitiveContext?: boolean;
  },
): void {
  for (const path of textTemplates(text)) {
    assertTemplatePath(file, stepIndex, key, path, opts);
  }
}

function assertValueTemplates(
  file: string,
  stepIndex: number | undefined,
  key: string,
  value: unknown,
  opts: {
    producers: Map<string, StepProducer>;
    inputNames: Set<string>;
    earlierOnly: boolean;
    maxStepIndex?: number;
  },
): void {
  if (typeof value === "string") {
    assertTemplates(file, stepIndex, key, value, opts);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertValueTemplates(file, stepIndex, `${key}[${i}]`, item, opts));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertValueTemplates(file, stepIndex, `${key}.${k}`, v, opts);
    }
  }
}

function assertStepTemplates(
  file: string,
  stepIndex: number,
  step: WorkflowStep,
  opts: {
    producers: Map<string, StepProducer>;
    inputNames: Set<string>;
  },
): void {
  const common = {
    producers: opts.producers,
    inputNames: opts.inputNames,
    earlierOnly: true,
    maxStepIndex: stepIndex,
  };
  if (step.when?.kind === "truthy" || step.when?.kind === "eq") {
    const path = parseTemplatePath(step.when.path);
    if (path) assertTemplatePath(file, stepIndex, "when", path, common);
  }
  for (const path of stepTemplates(step)) {
    assertTemplatePath(file, stepIndex, "step", path, common);
  }
  const action = step.action;
  if (action.kind === "herdr" && action.params) {
    assertValueTemplates(file, stepIndex, "params", action.params, common);
  }
}

function buildProducers(
  steps: WorkflowStep[],
  childReturnsById: Map<string, ReturnsSpec | undefined>,
): Map<string, StepProducer> {
  const out = new Map<string, StepProducer>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!step.id) continue;
    const producer = classifyProducer(step, i + 1, childReturnsById.get(step.id));
    if (producer) out.set(step.id, producer);
  }
  return out;
}

export function assertWorkflowReferences(
  file: string,
  workflow: LoadedWorkflow,
  childReturnsById: Map<string, ReturnsSpec | undefined>,
): Map<string, StepProducer> {
  assertUniqueStepIds(file, workflow.steps);
  const producers = buildProducers(workflow.steps, childReturnsById);
  const inputNames = new Set(workflow.inputs.map((input) => input.name));

  for (let i = 0; i < workflow.steps.length; i++) {
    assertStepTemplates(file, i + 1, workflow.steps[i]!, { producers, inputNames });
  }

  if (workflow.returns) {
    const opts = {
      producers,
      inputNames,
      earlierOnly: false,
      rejectSensitiveContext: true,
    };
    if (workflow.returns.kind === "template") {
      if (!isWholeValueTemplate(workflow.returns.template)) {
        bail(file, undefined, "returns", "returns: must be a whole-value template");
      }
      assertTemplates(file, undefined, "returns", workflow.returns.template, opts);
    } else {
      for (const [name, template] of Object.entries(workflow.returns.fields)) {
        if (!isWholeValueTemplate(template)) {
          bail(file, undefined, `returns.${name}`, "returns: must be a whole-value template");
        }
        assertTemplates(file, undefined, `returns.${name}`, template, opts);
      }
    }
  }

  if (workflow.onFailure) {
    const opts = { producers, inputNames, earlierOnly: false };
    for (const path of stepTemplates({ action: workflow.onFailure })) {
      assertTemplatePath(file, undefined, "on_failure", path, opts);
    }
    if (workflow.onFailure.kind === "herdr" && workflow.onFailure.params) {
      assertValueTemplates(file, undefined, "on_failure.params", workflow.onFailure.params, opts);
    }
  }

  return producers;
}

export function assertChildInputContract(
  file: string,
  stepIndex: number | undefined,
  passed: Record<string, string> | undefined,
  child: LoadedWorkflow,
  producers: Map<string, StepProducer>,
  parentInputNames: Set<string>,
  profiles: Set<string>,
): void {
  const declared = new Map(child.inputs.map((input) => [input.name, input]));
  const values = passed ?? {};
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      bail(file, stepIndex, `inputs.${key}`, `unknown child input '${key}'`);
    }
  }
  for (const input of child.inputs) {
    if (input.default === undefined && values[input.name] === undefined) {
      bail(file, stepIndex, `inputs.${input.name}`, `missing required child input '${input.name}'`);
    }
  }
  for (const [name, raw] of Object.entries(values)) {
    const input = declared.get(name)!;
    assertChildInputValue(file, stepIndex, name, raw, input, producers, parentInputNames, profiles);
  }
}

function assertChildInputValue(
  file: string,
  stepIndex: number | undefined,
  name: string,
  raw: string,
  input: InputSpec,
  producers: Map<string, StepProducer>,
  parentInputNames: Set<string>,
  profiles: Set<string>,
): void {
  const key = `inputs.${name}`;
  if (isWholeValueTemplate(raw)) {
    const path = parseTemplatePath(raw.slice(2, -2).trim());
    if (!path) {
      bail(file, stepIndex, key, "invalid whole-value template");
    }
    assertTemplatePath(file, stepIndex, key, path, {
      producers,
      inputNames: parentInputNames,
      earlierOnly: true,
      maxStepIndex: stepIndex,
    });
    const sourceType = sourceTypeOf(path, producers, parentInputNames);
    if (sourceType === "object" || sourceType === "number" || sourceType === "boolean") {
      bail(
        file,
        stepIndex,
        key,
        `child input '${name}' must resolve to text (source type ${sourceType})`,
      );
    }
  } else {
    assertTemplates(file, stepIndex, key, raw, {
      producers,
      inputNames: parentInputNames,
      earlierOnly: true,
      maxStepIndex: stepIndex,
    });
  }

  if (raw.includes("{{")) return;

  if (input.type === "profile" && !profiles.has(raw)) {
    bail(file, stepIndex, key, `child input '${name}' must name a merged profile`);
  }
  if (input.type === "choice" && input.options && !input.options.includes(raw)) {
    bail(file, stepIndex, key, `child input '${name}' must be one of: ${input.options.join(", ")}`);
  }
}

export function workflowChildNames(workflow: LoadedWorkflow): string[] {
  const names: string[] = [];
  for (const step of workflow.steps) {
    if (step.action.kind === "workflow") names.push(step.action.name);
  }
  if (workflow.onFailure?.kind === "workflow") names.push(workflow.onFailure.name);
  return names;
}
