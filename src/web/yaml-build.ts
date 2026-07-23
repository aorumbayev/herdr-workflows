import type { RawStep, RawWorkflow } from "../workflows/parse";

const IND = "  ";

/** A scalar is safe unquoted in block context when it starts with no YAML indicator, carries no
 *  `: `/` #`/trailing-`:` that would flip it into a mapping or comment, and would not be
 *  re-parsed as a bool/null/number. */
function plainOk(s: string): boolean {
  if (s === "") return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(s)) return false;
  if (/:\s/.test(s) || /\s#/.test(s)) return false;
  if (s.endsWith(":") || /\s$/.test(s)) return false;
  if (/^(true|false|null|~)$/i.test(s)) return false;
  if (/^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-f]+|\.(nan|inf))$/i.test(s)) return false;
  return true;
}

function quoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function scalar(v: string): string {
  if (plainOk(v)) return v;
  return quoted(v);
}

/** Literal blocks survive intact only when no line has leading/trailing whitespace; anything
 *  else falls back to a double-quoted scalar so content round-trips byte-exact. */
function blockSafe(v: string): boolean {
  return v.split("\n").every((ln) => ln === ln.trim() || ln === "");
}

/** Emit `key: value`, using a literal block scalar for multi-line strings so prompts stay readable.
 *  `|-` strips trailing newlines, so values ending in `\n` (or with ragged whitespace) fall back
 *  to a double-quoted scalar to round-trip byte-exact. */
function field(lines: string[], indent: string, key: string, v: string): void {
  if (v.includes("\n")) {
    if (!v.endsWith("\n") && blockSafe(v)) {
      lines.push(`${indent}${key}: |-`);
      for (const ln of v.split("\n")) lines.push(`${indent}${IND}${ln}`);
      return;
    }
    lines.push(`${indent}${key}: ${quoted(v)}`);
    return;
  }
  lines.push(`${indent}${key}: ${scalar(v)}`);
}

function dumpStep(step: RawStep): string[] {
  const m: string[] = [];
  const I = IND + IND; // step mapping keys sit at 4-space indent
  if (step.shell !== undefined) {
    field(m, I, "shell", step.shell);
    if (step.stdin !== undefined) field(m, I, "stdin", step.stdin);
  } else if (step.open !== undefined) {
    field(m, I, "open", step.open);
    if (step.wait_for !== undefined) field(m, I, "wait_for", step.wait_for);
    if (step.timeout !== undefined) m.push(`${I}timeout: ${step.timeout}`);
  } else if (step.agent !== undefined) {
    field(m, I, "agent", step.agent);
    if (step.prompt !== undefined) field(m, I, "prompt", step.prompt);
    if (step.wait !== undefined) m.push(`${I}wait: done`);
    if (step.timeout !== undefined) m.push(`${I}timeout: ${step.timeout}`);
    if (step.close_source !== undefined) m.push(`${I}close_source: ${step.close_source}`);
  } else if (step.herdr !== undefined) {
    field(m, I, "herdr", step.herdr);
    if (step.params !== undefined) m.push(`${I}params: ${JSON.stringify(step.params)}`);
  } else if (step.run !== undefined) {
    field(m, I, "run", step.run);
  }
  if (m.length === 0) m.push(`${I}shell: ""`);
  // Fold the first key onto the sequence dash: "    shell: x" -> "  - shell: x".
  m[0] = `${IND}- ${m[0]!.slice(I.length)}`;
  return m;
}

function dumpInputs(lines: string[], inputs: NonNullable<RawWorkflow["inputs"]>): void {
  lines.push("inputs:");
  for (const [name, inp] of Object.entries(inputs)) {
    lines.push(`${IND}${scalar(name)}:`);
    if (inp.label !== undefined) lines.push(`${IND}${IND}label: ${scalar(inp.label)}`);
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

/** Serialize a workflow to readable block YAML with a blank line between steps.
 *  Deliberately more generous with whitespace than the validator requires. */
export function dumpWorkflow(doc: RawWorkflow): string {
  const lines: string[] = [];
  if (doc.inputs && Object.keys(doc.inputs).length > 0) {
    dumpInputs(lines, doc.inputs);
    lines.push("");
  }
  lines.push("steps:");
  doc.steps.forEach((step, i) => {
    if (i > 0) lines.push("");
    lines.push(...dumpStep(step));
  });
  if (doc.on_fail !== undefined) {
    lines.push("");
    lines.push(`on_fail: ${scalar(doc.on_fail)}`);
  }
  return `${lines.join("\n")}\n`;
}
