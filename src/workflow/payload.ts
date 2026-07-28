import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { CAPTURE_BYTE_LIMIT, CaptureLimitError } from "../limits";
import { WorkflowLoadError } from "./types";

/** Same grammar as workbench deep-links / picker sources. */
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

const entrySchema = z
  .object({
    name: z.string().regex(WORKFLOW_NAME_RE, "workflow name must match [a-z0-9][a-z0-9-_]*"),
    yaml: z.string().min(1, "yaml must be non-empty"),
  })
  .strict();

const bundleSchema = z
  .array(entrySchema)
  .min(1, "bundle must contain at least one workflow")
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate workflow name '${name}'`,
          path: [i, "name"],
        });
      }
      seen.add(name);
    }
  });

export type WorkflowBundleEntry = z.infer<typeof entrySchema>;
export type WorkflowBundle = z.infer<typeof bundleSchema>;

/** gzip OS byte forced to Unix so macOS/Linux encode to the same paste payload. */
const GZIP_OS_UNIX = 3;

const IMPORT_COMMAND_RE = /^hwf\s+workflow\s+import\s+"([^"]+)"\s*$/;

export function encodePayload(entries: WorkflowBundle): string {
  const parsed = bundleSchema.safeParse(entries);
  if (!parsed.success) {
    throw new WorkflowLoadError(
      `cannot encode bundle: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(JSON.stringify(parsed.data))));
  gz[9] = GZIP_OS_UNIX;
  return Buffer.from(gz).toString("base64");
}

export function formatImportCommand(payload: string): string {
  return `hwf workflow import "${payload}"`;
}

/** Accept a raw encoded bundle or the exact generated import command. Never runs a shell. */
export function extractPayload(text: string): string {
  const trimmed = text.trim();
  const cmd = IMPORT_COMMAND_RE.exec(trimmed);
  if (cmd) return cmd[1]!;
  if (/^hwf\b/i.test(trimmed) || /^herdr-workflows\b/i.test(trimmed)) {
    throw new WorkflowLoadError('expected canonical command: hwf workflow import "<payload>"');
  }
  return trimmed;
}

function gunzipBounded(encoded: string): string {
  const compact = encoded.replace(/\s+/g, "");
  const encodedBytes = Buffer.byteLength(compact);
  if (encodedBytes > CAPTURE_BYTE_LIMIT) {
    throw new CaptureLimitError("workflow bundle", encodedBytes);
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(compact, "base64"), { maxOutputLength: CAPTURE_BYTE_LIMIT });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new CaptureLimitError("workflow bundle", CAPTURE_BYTE_LIMIT + 1);
    }
    throw new WorkflowLoadError("not an hwf workflow payload (expected base64 from the docs)");
  }
  if (raw.byteLength > CAPTURE_BYTE_LIMIT) {
    throw new CaptureLimitError("workflow bundle", raw.byteLength);
  }
  return raw.toString("utf8");
}

export function decodePayload(payload: string): WorkflowBundle {
  const json = gunzipBounded(extractPayload(payload));
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorkflowLoadError("payload decoded but is not JSON");
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const row = parsed as Record<string, unknown>;
    if ("v" in row || ("name" in row && "body" in row)) {
      throw new WorkflowLoadError(
        "payload uses the removed single-workflow format; re-export as a workflow bundle",
      );
    }
  }
  const result = bundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkflowLoadError(
      `payload is not a shared workflow bundle: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}
