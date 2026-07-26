import { herdrCall, HerdrError } from "./adapter/rpc";
import { checkHerdrProtocol } from "./herdr-methods";

let checked = false;

/** One-shot startup check against the connected herdr. No-ops when no socket is configured. */
export async function ensureHerdrProtocol(): Promise<void> {
  if (checked) return;
  if (!process.env.HERDR_SOCKET_PATH) return;
  const result = await herdrCall("ping", {});
  const check = checkHerdrProtocol(result.protocol);
  if (!check.ok) throw new HerdrError("protocol_mismatch", check.error);
  checked = true;
}
