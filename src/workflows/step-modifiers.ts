import { isResultDotPath } from "../herdr-methods";
import {
  bail,
  type ForSource,
  type Guard,
  type OutSpec,
  type RetrySpec,
  type RunPayload,
  type ShellName,
  type WaitSpec,
} from "./types";
import type { RawStep } from "./parse";
import { SHELLS } from "./step-keys";
import { findV1InputPlaceholder, findV1Last, firstPlaceholder } from "./substitute";

const PLACEHOLDER_SHELL =
  'placeholders are not allowed in shell command text — use argv form (run: [cmd, "{name}"]) or HWF_<name> env vars';

const NONEMPTY_GUARD_RE = /^(!?)\{([a-z][a-z0-9_]{0,31})\}$/;
const FOR_BINDING_RE = /^\{([a-z][a-z0-9_]{0,31})\}$/;
const FOR_SH_RE = /^sh\s+(.+)$/s;

export function rejectV1Placeholders(
  file: string,
  stepIndex: number,
  key: string | undefined,
  text: string,
): void {
  if (findV1Last(text)) {
    bail(file, stepIndex, key, `'{last}' is removed — bind a named out: on the producing step`);
  }
  const input = findV1InputPlaceholder(text);
  if (input) {
    bail(file, stepIndex, key, `'{input.${input}}' is removed — use {${input}}`);
  }
}

function rejectShellPlaceholders(
  file: string,
  stepIndex: number,
  key: string | undefined,
  text: string,
): void {
  rejectV1Placeholders(file, stepIndex, key, text);
  if (firstPlaceholder(text)) {
    bail(file, stepIndex, key, PLACEHOLDER_SHELL);
  }
}

export function parseGuard(file: string, stepIndex: number, key: string, value: unknown): Guard {
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, key, "argv guard elements must be strings");
    }
    for (const el of value) rejectV1Placeholders(file, stepIndex, key, el);
    return { kind: "argv", argv: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, key, "when:/until: must be a string or argv list");
  }
  rejectV1Placeholders(file, stepIndex, key, value);
  const m = NONEMPTY_GUARD_RE.exec(value);
  if (m) return { kind: "nonempty", name: m[2]!, negate: m[1] === "!" };
  rejectShellPlaceholders(file, stepIndex, key, value);
  return { kind: "shell", command: value };
}

export function parseFor(file: string, stepIndex: number, value: unknown): ForSource {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      bail(file, stepIndex, "for", "for: list is empty");
    }
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, "for", "for: list elements must be strings");
    }
    return { kind: "list", items: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, "for", "for: must be a list, sh <cmd>, or {name}");
  }
  rejectV1Placeholders(file, stepIndex, "for", value);
  const bind = FOR_BINDING_RE.exec(value);
  if (bind) return { kind: "binding", name: bind[1]! };
  const sh = FOR_SH_RE.exec(value);
  if (sh) {
    rejectShellPlaceholders(file, stepIndex, "for", sh[1]!);
    return { kind: "sh", command: sh[1]! };
  }
  bail(file, stepIndex, "for", "for: must be a list, sh <cmd>, or {name}");
}

export function parseRetry(file: string, stepIndex: number, value: unknown): RetrySpec {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      bail(file, stepIndex, "retry", "times must be at least 1");
    }
    return { times: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bail(file, stepIndex, "retry", "retry: must be an integer or map");
  }
  const map = value as Record<string, unknown>;
  const times = map.times;
  if (typeof times !== "number" || !Number.isInteger(times) || times < 1) {
    bail(file, stepIndex, "retry", "times must be at least 1");
  }
  const spec: RetrySpec = { times };
  if (map.delay !== undefined) {
    if (typeof map.delay !== "number" || map.delay < 0) {
      bail(file, stepIndex, "retry", "delay must be a non-negative number");
    }
    spec.delaySec = map.delay;
  }
  if (map.until !== undefined) spec.until = parseGuard(file, stepIndex, "until", map.until);
  if (map.reset !== undefined) {
    if (typeof map.reset !== "string") {
      bail(file, stepIndex, "retry", "reset: must be a shell command string");
    }
    rejectShellPlaceholders(file, stepIndex, "reset", map.reset);
    spec.reset = map.reset;
  }
  return spec;
}

export function parseWait(file: string, stepIndex: number, value: unknown): WaitSpec {
  if (value === undefined || value === true) return { kind: "block" };
  if (value === false) return { kind: "detach" };
  if (
    typeof value === "string" &&
    value.length >= 2 &&
    value.startsWith("/") &&
    value.endsWith("/")
  ) {
    return { kind: "regex", pattern: value.slice(1, -1) };
  }
  bail(file, stepIndex, "wait", "wait: must be true, false, or /regex/");
}

export function parseOut(file: string, stepIndex: number, value: unknown): OutSpec {
  if (typeof value === "string") {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(value)) {
      bail(file, stepIndex, "out", "out: name must match [a-z][a-z0-9_]{0,31}");
    }
    return { kind: "text", name: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const fields: Record<string, string> = {};
    for (const [name, path] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
        bail(file, stepIndex, "out", `out: name '${name}' must match [a-z][a-z0-9_]{0,31}`);
      }
      if (typeof path !== "string" || !path) {
        bail(file, stepIndex, "out", `out.${name} must be a dot-path string`);
      }
      if (!isResultDotPath(path)) {
        bail(file, stepIndex, "out", `out.${name}: unresolvable result path '${path}'`);
      }
      fields[name] = path;
    }
    return { kind: "map", fields };
  }
  bail(file, stepIndex, "out", "out: must be an identifier or map");
}

export function parseRunPayload(file: string, stepIndex: number, step: RawStep): RunPayload {
  const value = step.run;
  const shell = (typeof step.shell === "string" ? step.shell : "sh") as ShellName;
  if (!(SHELLS as readonly string[]).includes(shell)) {
    bail(file, stepIndex, "shell", `shell: must be one of ${SHELLS.join(", ")}`);
  }
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      bail(file, stepIndex, "run", "argv elements must be strings");
    }
    for (const el of value) rejectV1Placeholders(file, stepIndex, "run", el);
    return { form: "argv", argv: value };
  }
  if (typeof value !== "string") {
    bail(file, stepIndex, "run", "run: must be a string or argv list");
  }
  rejectShellPlaceholders(file, stepIndex, "run", value);
  return { form: value.includes("\n") ? "block" : "scalar", command: value, shell };
}
