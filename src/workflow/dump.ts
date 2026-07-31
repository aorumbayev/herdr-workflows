import { schemaPointer } from "./share";
import { rawStepKeyOrder, type RawStep, type RawWorkflowDoc } from "./parse";

const IND = "  ";
const ACTION_KEYS = new Set(["agent", "run", "herdr", "workflow", "params"]);
const SCHEMA_KEYS = new Set(rawStepKeyOrder);

function scalar(v: string): string {
  return Bun.YAML.stringify(v);
}

function blockSafe(v: string): boolean {
  return v.split("\n").every((ln) => ln === ln.trim() || ln === "");
}

function field(lines: string[], indent: string, key: string, v: string): void {
  if (v.includes("\n")) {
    if (!v.endsWith("\n") && blockSafe(v)) {
      lines.push(`${indent}${key}: |-`);
      for (const ln of v.split("\n")) lines.push(`${indent}${IND}${ln}`);
      return;
    }
    lines.push(`${indent}${key}: ${scalar(v)}`);
    return;
  }
  lines.push(`${indent}${key}: ${scalar(v)}`);
}

function dumpValue(lines: string[], indent: string, key: string, value: unknown): void {
  if (typeof value === "string") field(lines, indent, key, value);
  else if (value !== undefined) lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
}

function dumpActionLines(step: RawStep, indent: string): string[] {
  const m: string[] = [];
  if (typeof step.agent === "string") {
    field(m, indent, "agent", step.agent);
  } else if (typeof step.run === "string") {
    field(m, indent, "run", step.run);
  } else if (Array.isArray(step.run)) {
    m.push(`${indent}run: ${JSON.stringify(step.run)}`);
  } else if (typeof step.herdr === "string") {
    field(m, indent, "herdr", step.herdr);
    if (step.params && typeof step.params === "object") {
      m.push(`${indent}params: ${JSON.stringify(step.params)}`);
    }
  } else if (typeof step.workflow === "string") {
    field(m, indent, "workflow", step.workflow);
  } else {
    m.push(`${indent}run: ""`);
  }
  for (const key of rawStepKeyOrder) {
    if (ACTION_KEYS.has(key)) continue;
    const value = (step as Record<string, unknown>)[key];
    if (value !== undefined) dumpValue(m, indent, key, value);
  }
  for (const [key, value] of Object.entries(step)) {
    if (SCHEMA_KEYS.has(key) || value === undefined) continue;
    dumpValue(m, indent, key, value);
  }
  if (m.length === 0) m.push(`${indent}run: ""`);
  return m;
}

function dumpStep(step: RawStep): string[] {
  const I = IND + IND;
  const m = dumpActionLines(step, I);
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
}

/** `on_failure` is a mapping, not a list item. */
function dumpRecovery(step: RawStep): string[] {
  return dumpActionLines(step, IND);
}

function dumpInputs(lines: string[], inputs: NonNullable<RawWorkflowDoc["inputs"]>): void {
  lines.push("inputs:");
  for (const [name, inp] of Object.entries(inputs)) {
    if (typeof inp === "string") {
      lines.push(`${IND}${scalar(name)}: ${scalar(inp)}`);
      continue;
    }
    if (Array.isArray(inp)) {
      lines.push(`${IND}${scalar(name)}: ${JSON.stringify(inp)}`);
      continue;
    }
    lines.push(`${IND}${scalar(name)}:`);
    if (inp.type !== undefined) lines.push(`${IND}${IND}type: ${inp.type}`);
    if (inp.description !== undefined)
      lines.push(`${IND}${IND}description: ${scalar(inp.description)}`);
    if (inp.options !== undefined) {
      if (Array.isArray(inp.options)) {
        lines.push(`${IND}${IND}options:`);
        for (const o of inp.options) lines.push(`${IND}${IND}${IND}- ${scalar(o)}`);
      } else {
        lines.push(`${IND}${IND}options: ${JSON.stringify(inp.options)}`);
      }
    }
    if (inp.default !== undefined) lines.push(`${IND}${IND}default: ${scalar(inp.default)}`);
    if (inp.when !== undefined) lines.push(`${IND}${IND}when: ${JSON.stringify(inp.when)}`);
    if (inp.allow_custom !== undefined) {
      lines.push(`${IND}${IND}allow_custom: ${String(inp.allow_custom)}`);
    }
    if (inp.min_length !== undefined) lines.push(`${IND}${IND}min_length: ${inp.min_length}`);
  }
}

export function dumpWorkflow(doc: RawWorkflowDoc): string {
  const lines: string[] = [];
  lines.push(schemaPointer());
  lines.push(`version: ${scalar(doc.version)}`);
  if (doc.title) {
    field(lines, "", "title", doc.title);
  }
  if (doc.description) {
    field(lines, "", "description", doc.description);
  }
  if (doc.hidden === true) lines.push("hidden: true");
  if (doc.inputs && Object.keys(doc.inputs).length > 0) {
    lines.push("");
    dumpInputs(lines, doc.inputs);
  }
  if (doc.returns !== undefined) {
    lines.push("");
    if (typeof doc.returns === "string") field(lines, "", "returns", doc.returns);
    else lines.push(`returns: ${JSON.stringify(doc.returns)}`);
  }
  lines.push("");
  lines.push("steps:");
  doc.steps.forEach((step, i) => {
    if (i > 0) lines.push("");
    lines.push(...dumpStep(step));
  });
  if (doc.on_failure) {
    lines.push("");
    lines.push("on_failure:");
    lines.push(...dumpRecovery(doc.on_failure as RawStep));
  }
  return `${lines.join("\n")}\n`;
}
