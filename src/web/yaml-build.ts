import type { RawStep, RawWorkflow } from "../workflows/parse";

const IND = "  ";

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

function dumpStep(step: RawStep): string[] {
  const m: string[] = [];
  const I = IND + IND;
  if (typeof step.run === "string") {
    field(m, I, "run", step.run);
  } else if (Array.isArray(step.run)) {
    m.push(`${I}run: ${JSON.stringify(step.run)}`);
  } else if (typeof step.agent === "string") {
    field(m, I, "agent", step.agent);
    if (typeof step.prompt === "string") field(m, I, "prompt", step.prompt);
    if (typeof step.timeout === "number") m.push(`${I}timeout: ${step.timeout}`);
  } else {
    const method = Object.keys(step).find((k) => k.includes("."));
    if (method) {
      const params = step[method];
      if (params && typeof params === "object") {
        m.push(`${I}${method}: ${JSON.stringify(params)}`);
      } else {
        m.push(`${I}${method}:`);
      }
    } else if (typeof step.use === "string") {
      field(m, I, "use", step.use);
    } else {
      m.push(`${I}run: ""`);
    }
  }
  if (typeof step.name === "string") field(m, I, "name", step.name);
  if (typeof step.in === "string") m.push(`${I}in: ${step.in}`);
  if (typeof step.shell === "string") m.push(`${I}shell: ${step.shell}`);
  if (typeof step.out === "string") m.push(`${I}out: ${step.out}`);
  if (step.wait === false) m.push(`${I}wait: false`);
  if (typeof step.wait === "string") m.push(`${I}wait: ${step.wait}`);
  if (m.length === 0) m.push(`${I}run: ""`);
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
}

function dumpInputs(lines: string[], inputs: NonNullable<RawWorkflow["inputs"]>): void {
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
    if (inp.label !== undefined) lines.push(`${IND}${IND}label: ${scalar(inp.label)}`);
    if (inp.desc !== undefined) lines.push(`${IND}${IND}desc: ${scalar(inp.desc)}`);
    if (inp.type !== undefined) lines.push(`${IND}${IND}type: ${inp.type}`);
    if (inp.options !== undefined) {
      if (Array.isArray(inp.options)) {
        lines.push(`${IND}${IND}options:`);
        for (const o of inp.options) lines.push(`${IND}${IND}${IND}- ${scalar(o)}`);
      } else {
        lines.push(`${IND}${IND}options: ${scalar(inp.options)}`);
      }
    }
    if (inp.default !== undefined) lines.push(`${IND}${IND}default: ${scalar(inp.default)}`);
  }
}

export function dumpWorkflow(doc: RawWorkflow): string {
  const lines: string[] = [];
  if (doc.desc) {
    field(lines, "", "desc", doc.desc);
    lines.push("");
  }
  if (doc.inputs && Object.keys(doc.inputs).length > 0) {
    dumpInputs(lines, doc.inputs);
    lines.push("");
  }
  lines.push("steps:");
  doc.steps.forEach((step, i) => {
    if (i > 0) lines.push("");
    lines.push(...dumpStep(step));
  });
  if (typeof doc.on_error === "string") {
    lines.push("");
    lines.push(`on_error: ${scalar(doc.on_error)}`);
  }
  return `${lines.join("\n")}\n`;
}
