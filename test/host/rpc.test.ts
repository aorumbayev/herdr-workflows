import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrBinPath, herdrRequest, notificationShow } from "../../src/host";
import { isCoordinationError } from "../../src/engine";

describe("herdrBinPath", () => {
  test("empty or whitespace HERDR_BIN_PATH falls back to herdr", () => {
    const prev = process.env.HERDR_BIN_PATH;
    try {
      process.env.HERDR_BIN_PATH = "";
      expect(herdrBinPath()).toBe("herdr");
      process.env.HERDR_BIN_PATH = "   ";
      expect(herdrBinPath()).toBe("herdr");
      delete process.env.HERDR_BIN_PATH;
      expect(herdrBinPath()).toBe("herdr");
    } finally {
      if (prev === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = prev;
    }
  });
});

describe("herdrRequest socket failures", () => {
  test("rejects when socket closes without a response and names the address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-workflows-rpc-"));
    const sockPath = join(dir, "herdr.sock");
    const prev = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = sockPath;
    const server = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(sockPath, () => resolve());
      server.on("error", reject);
    });

    try {
      await expect(herdrRequest("layout.apply", {})).rejects.toMatchObject({
        name: "HerdrError",
        code: "closed",
        message: expect.stringContaining("layout.apply"),
      });
      await expect(herdrRequest("layout.apply", {})).rejects.toMatchObject({
        message: "layout.apply: socket closed before response",
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

  test("unknown spawn failure wraps as internal, not coordination loss", async () => {
    const prev = process.env.HERDR_BIN_PATH;
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr-bin-xyz";
    try {
      await notificationShow("title");
      throw new Error("expected notificationShow to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HerdrError);
      const herdr = error as HerdrError;
      expect(herdr.code).toBe("internal");
      expect(herdr.message).toMatch(/ENOENT/);
      expect(isCoordinationError(herdr)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = prev;
    }
  });
});
