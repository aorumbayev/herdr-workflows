/** Machine-readable launch acknowledgements on the observed stdout channel. */

export type HistoryAck =
  | { state: "claimed"; id: string }
  | { state: "unavailable"; id?: string }
  | { state: "rejected"; error: string; id?: string };

const ACK_RE = /^@hwf-history:(claimed|unavailable|rejected)(?:\s+(\S+))?(?:\s+(.*))?$/;

export function formatHistoryAck(ack: HistoryAck): string {
  if (ack.state === "claimed") return `@hwf-history:claimed ${ack.id}`;
  if (ack.state === "unavailable") {
    return ack.id ? `@hwf-history:unavailable ${ack.id}` : "@hwf-history:unavailable";
  }
  return ack.id
    ? `@hwf-history:rejected ${ack.id} ${ack.error}`
    : `@hwf-history:rejected ${ack.error}`;
}

export function parseHistoryAck(line: string): HistoryAck | undefined {
  const m = ACK_RE.exec(line.trim());
  if (!m) return undefined;
  const state = m[1] as HistoryAck["state"];
  const second = m[2];
  const rest = m[3];
  if (state === "claimed") {
    if (!second) return undefined;
    return { state, id: second.toLowerCase() };
  }
  if (state === "unavailable") {
    return { state, ...(second ? { id: second.toLowerCase() } : {}) };
  }
  if (second && rest) {
    return { state: "rejected", id: second.toLowerCase(), error: rest };
  }
  return { state: "rejected", error: second ?? rest ?? "launch rejected" };
}
