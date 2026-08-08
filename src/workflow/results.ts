/**
 * Step-result contract: the typed shape of every natural step result, the field names
 * derived from those shapes, and the verdict parse shared by the runner and `hwf response check`.
 */

/** Blocking local command result. */
export type CommandResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  failed: boolean;
};

/** Blocking managed agent turn result. `verdict` is present only when the step declares `expect`. */
export type AgentResult = {
  response: string;
  agent: Record<string, unknown>;
  pane_id: string;
  verdict?: string;
};

/** Identifiers a placed command adds to the native readiness payload. */
export type ReadinessIds = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
};

/** Diagnostic keys a failed step carries into history through the failure fact. */
export type StepFailureDetails = {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  method?: string;
  verdict?: string;
};

type FieldNames<T> = Record<keyof T, true>;

const COMMAND_KEYS: FieldNames<CommandResult> = {
  stdout: true,
  stderr: true,
  exit_code: true,
  failed: true,
};

const AGENT_KEYS: FieldNames<Required<AgentResult>> = {
  response: true,
  agent: true,
  pane_id: true,
  verdict: true,
};

const READINESS_KEYS: FieldNames<ReadinessIds> = {
  pane_id: true,
  tab_id: true,
  workspace_id: true,
};

/** Native herdr AgentInfo, addressed through the herdr result-path table rather than field names. */
export const AGENT_INFO_FIELD = "agent" satisfies keyof AgentResult;

/** Only readable when the producing step declares `expect`. */
export const AGENT_VERDICT_FIELD = "verdict" satisfies keyof AgentResult;

export const COMMAND_EXIT_CODE_FIELD = "exit_code" satisfies keyof CommandResult;

export type ScalarFieldType = "string" | "number" | "boolean";

/** Scalar type of each command-result field, single-sourced beside the field-name sets. */
const COMMAND_FIELD_TYPE_MAP = {
  stdout: "string",
  stderr: "string",
  [COMMAND_EXIT_CODE_FIELD]: "number",
  failed: "boolean",
} satisfies Record<keyof CommandResult, ScalarFieldType>;

export const COMMAND_FIELD_TYPES: ReadonlyMap<string, ScalarFieldType> = new Map(
  Object.entries(COMMAND_FIELD_TYPE_MAP),
);

export const COMMAND_FIELDS: ReadonlySet<string> = new Set(Object.keys(COMMAND_KEYS));

export const AGENT_STRING_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(AGENT_KEYS).filter(
    (name) => name !== AGENT_INFO_FIELD && name !== AGENT_VERDICT_FIELD,
  ),
);

export const READINESS_ID_FIELDS: ReadonlySet<string> = new Set(Object.keys(READINESS_KEYS));

/** Context keys a transcript can reach, which `returns:` must not carry out of the run. */
export const SENSITIVE_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "transcript",
  "transcript_file",
]);

function shapeOf(fields: Iterable<string>): string {
  return `{${[...fields].join(", ")}}`;
}

const AGENT_FIELD_ORDER = [
  "response",
  AGENT_INFO_FIELD,
  "pane_id",
] as const satisfies readonly (keyof AgentResult)[];

export const COMMAND_RESULT_SHAPE = shapeOf(COMMAND_FIELDS);

export const AGENT_RESULT_SHAPE = shapeOf(AGENT_FIELD_ORDER);

export const VERDICT_TOKEN_PATTERN = "[A-Z][A-Z0-9_]{0,31}";
export const VERDICT_TOKEN_RE = new RegExp(`^${VERDICT_TOKEN_PATTERN}$`);

export type ExpectSpec = {
  oneOf: string[];
  require?: string[];
};

export type VerdictParse = { ok: true; verdict: string } | { ok: false; line: string };

function finalNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return "";
}

/** The one verdict oracle: final non-empty line, trimmed, matched exactly against the tokens. */
export function parseVerdict(response: string, oneOf: readonly string[]): VerdictParse {
  const line = finalNonEmptyLine(response);
  if (oneOf.includes(line)) return { ok: true, verdict: line };
  return { ok: false, line };
}

export function verdictMismatchMessage(line: string, oneOf: readonly string[]): string {
  const found = line ? JSON.stringify(line) : "an empty response";
  return `final non-empty line ${found} is not a verdict token — expected exactly one of: ${oneOf.join(", ")}`;
}

export function verdictNotRequiredMessage(verdict: string, require: readonly string[]): string {
  return `verdict ${verdict} is not accepted — this step requires one of: ${require.join(", ")}`;
}

export type VerdictTokens = { ok: true; tokens: string[] } | { ok: false; error: string };

/** Decode a comma-separated `--one-of` list under the same rules as `expect.one_of`. */
export function parseVerdictTokens(raw: string): VerdictTokens {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { ok: false, error: "--one-of requires at least one verdict token" };
  }
  for (const token of tokens) {
    if (!VERDICT_TOKEN_RE.test(token)) {
      return {
        ok: false,
        error: `invalid verdict token '${token}' — must match ${VERDICT_TOKEN_PATTERN}`,
      };
    }
  }
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) return { ok: false, error: `duplicate verdict token '${token}'` };
    seen.add(token);
  }
  return { ok: true, tokens };
}
