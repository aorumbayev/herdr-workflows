import { z } from "zod";
import { WorkflowLoadError } from "./types";

const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

const payloadSchema = z
  .object({
    v: z.literal(1),
    name: z.string().regex(WORKFLOW_NAME_RE, "workflow name must match [a-z][a-z0-9-]{0,63}"),
    body: z.string().min(1),
  })
  .strict();

export type WorkflowPayload = z.infer<typeof payloadSchema>;

/** gzip OS byte forced to Unix so macOS/Linux encode to the same paste payload. */
const GZIP_OS_UNIX = 3;

export function encodePayload(payload: WorkflowPayload): string {
  const gz = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload))));
  gz[9] = GZIP_OS_UNIX;
  return Buffer.from(gz).toString("base64");
}

export function decodePayload(payload: string): WorkflowPayload {
  const compact = payload.trim().replace(/\s+/g, "");
  let json: string;
  try {
    json = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(compact, "base64")));
  } catch {
    throw new WorkflowLoadError("not an hwf workflow payload (expected base64 from the docs)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorkflowLoadError("payload decoded but is not JSON");
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkflowLoadError(
      `payload is not a shared workflow: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}
