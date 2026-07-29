import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRequest, resolveHerdrSocketAddress } from "../src/herdr";
import { listenAddressForMarker, listenHerdrSocket } from "./herdr-socket";

describe("resolveHerdrSocketAddress", () => {
  test("throws no_socket when unset", () => {
    expect(() => resolveHerdrSocketAddress(undefined)).toThrow(
      expect.objectContaining({ name: "HerdrError", code: "no_socket" }),
    );
  });

  test("passes Unix paths unchanged", () => {
    const path = "/tmp/herdr.sock";
    expect(resolveHerdrSocketAddress(path)).toBe(path);
  });
});

describe("herdrRequest socket failures", () => {
  test("rejects when socket closes without a response and names the address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-rpc-"));
    const sockPath = join(dir, "herdr.sock");
    const prev = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = sockPath;
    const resolved = listenAddressForMarker(sockPath);

    const server = await listenHerdrSocket(sockPath, (socket) => {
      socket.end();
    });

    try {
      await expect(herdrRequest("layout.apply", {})).rejects.toMatchObject({
        name: "HerdrError",
        code: "unreachable",
        message: expect.stringContaining(`unreachable herdr at ${resolved}`),
      });
      await expect(herdrRequest("layout.apply", {})).rejects.toMatchObject({
        message: expect.stringContaining("layout.apply"),
      });
    } finally {
      server.close();
      if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreachable code is distinct from protocol_mismatch", () => {
    const transport = new HerdrError("unreachable", "unreachable herdr at /tmp/x: ping: boom");
    const protocol = new HerdrError("protocol_mismatch", "herdr protocol mismatch");
    expect(transport.code).not.toBe(protocol.code);
  });
});
