import { connect } from "node:net";
import { randomUUID } from "node:crypto";

export type HerdrResponse = {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

function bin(): string {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}

function socketPath(): string {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) throw new HerdrError("no_socket", "HERDR_SOCKET_PATH is not set");
  return path;
}

const RPC_TIMEOUT_MS = 10_000;

// Raw socket request. Prefer CLI wrappers when they exist; layout.apply has no CLI surface.
export function herdrRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<HerdrResponse> {
  const id = `herdr-workflows:${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify({ id, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath());
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      sock.destroy();
      settle(() =>
        reject(new HerdrError("timeout", `${method} timed out after ${RPC_TIMEOUT_MS}ms`)),
      );
    }, RPC_TIMEOUT_MS);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      sock.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as HerdrResponse;
        settle(() => resolve(parsed));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    sock.on("close", () => {
      settle(() => reject(new HerdrError("closed", `${method}: socket closed before response`)));
    });
    sock.on("error", (error) => settle(() => reject(error)));
  });
}

export async function herdrCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await herdrRequest(method, params);
  if (response.error) throw new HerdrError(response.error.code, response.error.message);
  if (!response.result) throw new HerdrError("empty_result", `no result for ${method}`);
  return response.result;
}

export async function herdrCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([bin(), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
