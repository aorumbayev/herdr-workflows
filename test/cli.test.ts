import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_PROTOCOL, MIN_HERDR_VERSION } from "../src/herdr-methods";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const home = await mkdtemp(join(tmpdir(), "hwf-cli-home-"));
  const state = await mkdtemp(join(tmpdir(), "hwf-cli-state-"));
  const plugin = await mkdtemp(join(tmpdir(), "hwf-cli-plugin-"));
  dirs.push(home, state, plugin);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    HERDR_PLUGIN_CONFIG_DIR: plugin,
    HERDR_PLUGIN_STATE_DIR: state,
  };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_PLUGIN_CONTEXT_JSON;
  delete env.HERDR_PANE_ID;
  delete env.HERDR_TAB_ID;
  delete env.HERDR_WORKSPACE_ID;
  Object.assign(env, extraEnv);
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args],
    {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function withPingSocket(
  pong: { protocol: number; version: string },
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hwf-cli-sock-"));
  dirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as { id: string };
      socket.end(
        `${JSON.stringify({
          id: req.id,
          result: { type: "pong", protocol: pong.protocol, version: pong.version },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.on("error", reject);
  });
  try {
    await fn(socketPath);
  } finally {
    server.close();
  }
}

describe("cli run", () => {
  test("run resolves workflows via HERDR_WORKFLOWS_REPO_ROOT from a foreign cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hwf-cli-elsewhere-"));
    dirs.push(root, elsewhere);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], elsewhere, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("run from a foreign cwd without the env var finds nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hwf-cli-elsewhere-"));
    dirs.push(root, elsewhere);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], elsewhere);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("run treats an empty HERDR_WORKFLOWS_REPO_ROOT as unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    const result = await runCli(["run", "hi"], root, { HERDR_WORKFLOWS_REPO_ROOT: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("run rejects herdr protocol before missing-input failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "needs.yaml"),
      [
        "version: v1alpha1",
        "inputs:",
        "  topic: text",
        "steps:",
        '  - run: [echo, "{{inputs.topic}}"]',
        "",
      ].join("\n"),
    );

    await withPingSocket(
      { protocol: HERDR_PROTOCOL + 1, version: MIN_HERDR_VERSION },
      async (socketPath) => {
        const result = await runCli(["run", "needs"], root, {
          HERDR_WORKFLOWS_REPO_ROOT: root,
          HERDR_SOCKET_PATH: socketPath,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("herdr protocol mismatch");
        expect(result.stderr).toContain(`pinned=${HERDR_PROTOCOL}`);
        expect(result.stderr).not.toMatch(/missing|required input|topic/i);
      },
    );
  });

  test("run rejects herdr version below manifest minimum before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "hi.yaml"),
      'version: v1alpha1\nsteps:\n  - run: "printf ok"\n',
    );

    await withPingSocket({ protocol: HERDR_PROTOCOL, version: "0.7.4" }, async (socketPath) => {
      const result = await runCli(["run", "hi"], root, {
        HERDR_WORKFLOWS_REPO_ROOT: root,
        HERDR_SOCKET_PATH: socketPath,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("herdr version too old");
      expect(result.stderr).toContain("installed=0.7.4");
      expect(result.stderr).toContain(`required≥${MIN_HERDR_VERSION}`);
      expect(result.stdout).not.toContain("[1/1]");
    });
  });
});

describe("cli web", () => {
  test("rejects invalid workbench routes before starting a server", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-web-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    const result = await runCli(["web", "http://evil.example", "--no-open"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("web route expects");
  });
});
