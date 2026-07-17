import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRequest } from "../src/adapter/rpc";

describe("herdrRequest socket failures", () => {
  test("rejects when socket closes without a response", async () => {
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
      await expect(herdrRequest("layout.apply", {})).rejects.toEqual(
        expect.objectContaining({
          name: "HerdrError",
          code: "closed",
          message: expect.stringContaining("layout.apply"),
        }),
      );
    } finally {
      server.close();
      if (prev === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
