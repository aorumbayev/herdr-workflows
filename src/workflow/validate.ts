import { isMethodResultDotPath, RESULT_DOT_PATHS } from "../herdr-methods";
import { clausesContain, evaluateWhen } from "./conditions";
import { isWholeValueTemplate, parseTemplatePath, textTemplates } from "./parse";
import {
  bail,
  IDENT_RE,
  type InputSpec,
  type LoadedWorkflow,
  type RecoveryAction,
  type ReturnsSpec,
  type StepAction,
  type TemplatePath,
  type TemplateNamespace,
  type WhenSpec,
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
  when?: WhenSpec[];
};

type SourceType = "string" | "number" | "boolean" | "object" | "unknown";

type TemplateOpts = {
  producers: Map<string, StepProducer>;
  inputsByName: Map<string, InputSpec>;
  earlierOnly: boolean;
  maxStepIndex?: number;
  rejectSensitiveContext?: boolean;
  allowContextError?: boolean;
  /** Clauses already proven at this site (structural containment). */
  proven?: WhenSpec[];
};

const COMMAND_FIELDS = new Set(["stdout", "stderr", "exit_code", "failed"]);
const AGENT_STRING_FIELDS = new Set(["response", "pane_id"]);
const READINESS_ID_FIELDS = new Set(["pane_id", "tab_id", "workspace_id"]);
const READINESS_HERDR_METHOD = "pane.wait_for_output";
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
  const base = {
    id: step.id,
    index,
    ...(step.when !== undefined ? { when: step.when } : {}),
  };

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

function pathAllowed(paths: Iterable<string>, fieldPath: string): boolean {
  const set = paths instanceof Set ? paths : new Set(paths);
  if (set.has(fieldPath)) return true;
  const prefix = `${fieldPath}.`;
  for (const path of set) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function globalResultFieldAllowed(fieldPath: string): boolean {
  return pathAllowed(RESULT_DOT_PATHS, fieldPath);
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
    if (!globalResultFieldAllowed(fieldSegments.join("."))) {
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
  if (!isMethodResultDotPath(READINESS_HERDR_METHOD, fieldSegments.join("."))) {
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
  const method = producer.herdrMethod;
  if (!method || !isMethodResultDotPath(method, fieldSegments.join("."))) {
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
  allowContextError: boolean,
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
    if (!allowContextError) {
      bail(file, stepIndex, key, "context.error is only available inside on_failure:");
    }
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
  inputsByName: Map<string, InputSpec>,
): SourceType {
  if (path.root === "inputs") {
    if (path.segments.length !== 1 || !inputsByName.has(path.segments[0]!)) return "unknown";
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
  return "unknown";
}

function assertAvailability(
  file: string,
  stepIndex: number | undefined,
  key: string,
  proven: WhenSpec[] | undefined,
  required: WhenSpec[] | undefined,
  label: string,
): void {
  if (!required || required.length === 0) return;
  const consumer = proven ?? [];
  const missing = required.filter((clause) => !clausesContain(consumer, [clause]));
  if (missing.length > 0) {
    const format = (clause: WhenSpec): string =>
      clause.kind === "truthy"
        ? `{{${clause.path}}}`
        : `{{${clause.path}}} ${clause.negate ? "!=" : "=="} ${JSON.stringify(clause.value)}`;
    bail(
      file,
      stepIndex,
      key,
      `${label} is not proven available — missing producer when: ${missing.map(format).join(", ")}; consumer must include: ${required.map(format).join(", ")}`,
    );
  }
}

export function shellUsesInput(command: string, name: string): boolean {
  const prefix = `HWF_${name}`;
  let from = 0;
  while (from <= command.length) {
    const i = command.indexOf(prefix, from);
    if (i === -1) break;
    const after = command[i + prefix.length];
    if (after === undefined || !/[A-Za-z0-9_]/.test(after)) return true;
    from = i + prefix.length;
  }
  return false;
}

function assertShellHwfGuards(
  file: string,
  stepIndex: number,
  command: string,
  opts: TemplateOpts,
): void {
  for (const input of opts.inputsByName.values()) {
    if (!input.when || input.when.length === 0) continue;
    if (!shellUsesInput(command, input.name)) continue;
    assertAvailability(file, stepIndex, "run", opts.proven, input.when, `input '${input.name}'`);
  }
}

function assertConditionScalar(
  file: string,
  stepIndex: number | undefined,
  key: string,
  path: TemplatePath,
  opts: TemplateOpts,
): void {
  const sourceType = sourceTypeOf(path, opts.producers, opts.inputsByName);
  if (sourceType === "object") {
    bail(
      file,
      stepIndex,
      key,
      "when: rejects structured sources — use a scalar field (string, number, boolean)",
    );
  }
}

function assertTemplatePath(
  file: string,
  stepIndex: number | undefined,
  key: string,
  path: TemplatePath,
  opts: TemplateOpts,
): void {
  if (path.root === "inputs") {
    if (path.segments.length !== 1 || !opts.inputsByName.has(path.segments[0]!)) {
      bail(file, stepIndex, key, `unknown input '${path.segments[0] ?? ""}'`);
    }
    const input = opts.inputsByName.get(path.segments[0]!)!;
    assertAvailability(file, stepIndex, key, opts.proven, input.when, `input '${input.name}'`);
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
    assertContextPath(file, stepIndex, key, path.segments, opts.allowContextError === true);
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
  assertAvailability(
    file,
    stepIndex,
    key,
    opts.proven,
    producer.when,
    `step '${producer.id}' result`,
  );
  assertProducerField(file, stepIndex, key, producer, path.segments.slice(1));
}

function assertTemplates(
  file: string,
  stepIndex: number | undefined,
  key: string,
  text: string,
  opts: TemplateOpts,
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
  opts: TemplateOpts,
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

function assertUsingProfile(
  file: string,
  stepIndex: number | undefined,
  key: string,
  using: string,
  profiles: Set<string>,
): void {
  if (using.includes("{{")) return;
  if (profiles.has(using)) return;
  const available = [...profiles].sort().join(", ");
  bail(
    file,
    stepIndex,
    key,
    available
      ? `unknown profile '${using}' (available: ${available})`
      : `unknown profile '${using}' (no profiles configured)`,
  );
}

function assertCwdEnvPane(
  file: string,
  stepIndex: number | undefined,
  action: Extract<StepAction, { kind: "agent" | "run" }>,
  opts: TemplateOpts,
  key: (name: string) => string,
): void {
  if (action.cwd !== undefined) assertTemplates(file, stepIndex, key("cwd"), action.cwd, opts);
  if (action.env !== undefined) assertValueTemplates(file, stepIndex, key("env"), action.env, opts);
  if (action.pane?.target !== undefined) {
    assertTemplates(file, stepIndex, key("pane.target"), action.pane.target, opts);
  }
  if (action.pane?.workspace !== undefined) {
    assertTemplates(file, stepIndex, key("pane.workspace"), action.pane.workspace, opts);
  }
  if (typeof action.pane?.open === "string" && action.pane.open.includes("{{")) {
    assertPaneOpenTemplate(file, stepIndex, key("pane.open"), action.pane.open, action.pane, opts);
  }
}

const PANE_OPEN_VALUES = new Set<string>(["tab", "beside", "below"]);

function assertPaneOpenTemplate(
  file: string,
  stepIndex: number | undefined,
  key: string,
  open: string,
  pane: { target?: string; workspace?: string; size?: number },
  opts: TemplateOpts,
): void {
  const path = parseTemplatePath(open.slice(2, -2).trim())!;
  if (path.root !== "inputs" || path.segments.length !== 1) {
    bail(
      file,
      stepIndex,
      key,
      "pane.open must reference an unconditional closed static choice input",
    );
  }
  const input = opts.inputsByName.get(path.segments[0]!);
  if (!input) {
    bail(file, stepIndex, key, `unknown input '${path.segments[0]}'`);
  }
  if (input.when && input.when.length > 0) {
    bail(file, stepIndex, key, `pane.open input '${input.name}' must be unconditional`);
  }
  if (input.type !== "choice" || input.dynamicOptions || input.allowCustom) {
    bail(file, stepIndex, key, `pane.open input '${input.name}' must be a closed static choice`);
  }
  if (!input.options || input.options.length === 0) {
    bail(file, stepIndex, key, `pane.open input '${input.name}' has no options`);
  }
  for (const option of input.options) {
    if (!PANE_OPEN_VALUES.has(option)) {
      bail(
        file,
        stepIndex,
        key,
        `pane.open input '${input.name}' options must be tab, beside, or below`,
      );
    }
  }
  const domain = new Set(input.options);
  if (domain.has("tab") && (pane.target !== undefined || pane.size !== undefined)) {
    bail(file, stepIndex, key, "pane.target/size are invalid when pane.open can resolve to tab");
  }
  if ((domain.has("beside") || domain.has("below")) && pane.workspace !== undefined) {
    bail(
      file,
      stepIndex,
      key,
      "pane.workspace is invalid when pane.open can resolve to beside/below",
    );
  }
}

function assertActionSites(
  file: string,
  stepIndex: number | undefined,
  action: StepAction | RecoveryAction,
  opts: TemplateOpts,
  profiles: Set<string>,
  keyPrefix?: string,
): void {
  const key = (name: string) => (keyPrefix ? `${keyPrefix}.${name}` : name);
  if (action.kind === "agent") {
    assertTemplates(file, stepIndex, key("agent"), action.prompt, opts);
    if (action.using !== undefined) {
      assertTemplates(file, stepIndex, key("using"), action.using, opts);
      assertUsingProfile(file, stepIndex, key("using"), action.using, profiles);
    }
    if (action.target !== undefined) {
      assertTemplates(file, stepIndex, key("target"), action.target, opts);
    }
    assertCwdEnvPane(file, stepIndex, action, opts, key);
    return;
  }
  if (action.kind === "run") {
    if (action.payload.form === "argv") {
      action.payload.argv.forEach((el, i) => {
        assertTemplates(file, stepIndex, key(`run[${i}]`), el, opts);
      });
    } else if (stepIndex !== undefined) {
      assertShellHwfGuards(file, stepIndex, action.payload.command, opts);
    }
    assertCwdEnvPane(file, stepIndex, action, opts, key);
    return;
  }
  if (action.kind === "herdr") {
    if (action.params !== undefined) {
      assertValueTemplates(file, stepIndex, key("params"), action.params, opts);
    }
    return;
  }
  if (action.inputs !== undefined) {
    assertValueTemplates(file, stepIndex, key("inputs"), action.inputs, opts);
  }
}

function assertStepTemplates(
  file: string,
  stepIndex: number,
  step: WorkflowStep,
  opts: TemplateOpts,
  profiles: Set<string>,
): void {
  const clauses = step.when ?? [];
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!;
    const path = parseTemplatePath(clause.path);
    const key = i === 0 && clauses.length === 1 ? "when" : `when[${i}]`;
    if (path) {
      assertTemplatePath(file, stepIndex, key, path, {
        ...opts,
        proven: clauses.slice(0, i),
      });
      assertConditionScalar(file, stepIndex, key, path, opts);
    }
  }
  assertActionSites(file, stepIndex, step.action, { ...opts, proven: clauses }, profiles);
}

function assertInputGuards(file: string, inputs: InputSpec[]): void {
  const earlier = new Map<string, InputSpec>();
  for (const input of inputs) {
    const clauses = input.when ?? [];
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!;
      const path = parseTemplatePath(clause.path);
      const key =
        clauses.length === 1 ? `inputs.${input.name}.when` : `inputs.${input.name}.when[${i}]`;
      if (!path) {
        bail(file, undefined, key, "when: must reference inputs|steps|context");
      }
      if (path.root !== "inputs" || path.segments.length !== 1) {
        bail(file, undefined, key, "input when: may only reference earlier inputs");
      }
      const target = path.segments[0]!;
      if (!earlier.has(target)) {
        if (target === input.name || !inputs.some((row) => row.name === target)) {
          bail(file, undefined, key, `unknown input '${target}'`);
        }
        bail(file, undefined, key, `forward reference to input '${target}'`);
      }
      const prior = earlier.get(target)!;
      assertAvailability(
        file,
        undefined,
        key,
        clauses.slice(0, i),
        prior.when,
        `input '${prior.name}'`,
      );
    }
    earlier.set(input.name, input);
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
  profiles: Set<string>,
): Map<string, StepProducer> {
  assertUniqueStepIds(file, workflow.steps);
  assertInputGuards(file, workflow.inputs);
  const producers = buildProducers(workflow.steps, childReturnsById);
  const inputsByName = new Map(workflow.inputs.map((input) => [input.name, input]));

  for (let i = 0; i < workflow.steps.length; i++) {
    assertStepTemplates(
      file,
      i + 1,
      workflow.steps[i]!,
      {
        producers,
        inputsByName,
        earlierOnly: true,
        maxStepIndex: i + 1,
        allowContextError: false,
      },
      profiles,
    );
  }

  if (workflow.returns) {
    const opts: TemplateOpts = {
      producers,
      inputsByName,
      earlierOnly: false,
      rejectSensitiveContext: true,
      allowContextError: false,
      proven: [],
    };
    if (workflow.returns.kind === "template") {
      assertTemplates(file, undefined, "returns", workflow.returns.template, opts);
    } else {
      for (const [name, template] of Object.entries(workflow.returns.fields)) {
        assertTemplates(file, undefined, `returns.${name}`, template, opts);
      }
    }
  }

  if (workflow.onFailure) {
    assertActionSites(
      file,
      undefined,
      workflow.onFailure,
      {
        producers,
        inputsByName,
        earlierOnly: false,
        allowContextError: true,
        proven: [],
      },
      profiles,
      "on_failure",
    );
  }

  return producers;
}

export function assertChildInputContract(
  file: string,
  stepIndex: number | undefined,
  passed: Record<string, string> | undefined,
  child: LoadedWorkflow,
  producers: Map<string, StepProducer>,
  parentInputs: InputSpec[],
  profiles: Set<string>,
  stepProven: WhenSpec[] = [],
): void {
  const declared = new Map(child.inputs.map((input) => [input.name, input]));
  const parentByName = new Map(parentInputs.map((input) => [input.name, input]));
  const values = passed ?? {};
  const knownInputs: Record<string, string> = {};
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      bail(file, stepIndex, `inputs.${key}`, `unknown child input '${key}'`);
    }
  }
  for (const input of child.inputs) {
    if (
      input.default === undefined &&
      values[input.name] === undefined &&
      !inputIsProvablyInactive(input, knownInputs)
    ) {
      bail(file, stepIndex, `inputs.${input.name}`, `missing required child input '${input.name}'`);
    }
    const value = values[input.name] ?? input.default;
    if (value === undefined || value.includes("{{")) continue;
    if (
      !input.when ||
      input.when.length === 0 ||
      evaluateWhen(input.when, namespace(knownInputs))
    ) {
      knownInputs[input.name] = value;
    }
  }
  for (const [name, raw] of Object.entries(values)) {
    const input = declared.get(name)!;
    assertChildInputValue(
      file,
      stepIndex,
      name,
      raw,
      input,
      producers,
      parentByName,
      profiles,
      stepProven,
    );
  }
}

function namespace(inputs: Record<string, string>): TemplateNamespace {
  return { inputs, steps: {}, context: {} };
}

function inputIsProvablyInactive(input: InputSpec, knownInputs: Record<string, string>): boolean {
  if (!input.when || input.when.length === 0) return false;
  if (
    input.when.some(
      (clause) =>
        !clause.path.startsWith("inputs.") || !Object.hasOwn(knownInputs, clause.path.slice(7)),
    )
  ) {
    return false;
  }
  return !evaluateWhen(input.when, namespace(knownInputs));
}

function assertChildInputValue(
  file: string,
  stepIndex: number | undefined,
  name: string,
  raw: string,
  input: InputSpec,
  producers: Map<string, StepProducer>,
  parentByName: Map<string, InputSpec>,
  profiles: Set<string>,
  proven: WhenSpec[],
): void {
  const key = `inputs.${name}`;
  const opts: TemplateOpts = {
    producers,
    inputsByName: parentByName,
    earlierOnly: true,
    maxStepIndex: stepIndex,
    allowContextError: false,
    proven,
  };
  if (isWholeValueTemplate(raw)) {
    const path = parseTemplatePath(raw.slice(2, -2).trim());
    if (!path) {
      bail(file, stepIndex, key, "invalid whole-value template");
    }
    assertTemplatePath(file, stepIndex, key, path, opts);
    const sourceType = sourceTypeOf(path, producers, parentByName);
    if (sourceType === "object" || sourceType === "number" || sourceType === "boolean") {
      bail(
        file,
        stepIndex,
        key,
        `child input '${name}' must resolve to text (source type ${sourceType})`,
      );
    }
  } else {
    assertTemplates(file, stepIndex, key, raw, opts);
  }

  if (raw.includes("{{")) return;

  if (input.type === "profile" && !profiles.has(raw)) {
    bail(file, stepIndex, key, `child input '${name}' must name a merged profile`);
  }
  if (
    input.type === "choice" &&
    input.options &&
    !input.allowCustom &&
    !input.options.includes(raw)
  ) {
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
