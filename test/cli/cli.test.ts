import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../herdr-plugin.toml";
import { HERDR_PROTOCOL, MIN_HERDR_VERSION } from "../../src/host";
import { encodePayload } from "../../src/workflow/exchange";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  stdinText?: string,
  preload?: string,
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
  const bunArgs = preload ? ["--preload", preload] : [];
  const proc = Bun.spawn(
    [process.execPath, ...bunArgs, join(import.meta.dir, "..", "..", "src", "cli.ts"), ...args],
    {
      cwd,
      env,
      stdin: stdinText === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (stdinText !== undefined) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error("expected piped stdin");
    stdin.write(stdinText);
    stdin.end();
  }
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

async function writeWorkflow(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
  await writeFile(join(root, ".hwf", "workflows", `${name}.yaml`), body);
}

describe("cli parse and dispatch", () => {
  test("no-args without a TTY prints generated help as an error and exits nonzero", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-usage-"));
    dirs.push(root);
    const result = await runCli([], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("run");
    expect(result.stderr).toContain("web");
    expect(result.stdout).toBe("");
  });

  test("hwf help prints generated root help", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-help-"));
    dirs.push(root);
    const result = await runCli(["help"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toMatch(/\brun\b/);
    expect(result.stdout).toMatch(/\bweb\b/);
    expect(result.stdout).toContain(manifest.description);
    expect(result.stdout).toContain("Workflow format: v1alpha1");
  });

  test("hwf --version and -V print the plugin manifest version", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-version-"));
    dirs.push(root);
    for (const flag of ["--version", "-V"]) {
      const result = await runCli([flag], root);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(manifest.version);
      expect(result.stderr).toBe("");
    }
  });

  test("hwf run --help and hwf help run print run usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-run-help-"));
    dirs.push(root);
    for (const args of [
      ["run", "--help"],
      ["help", "run"],
    ]) {
      const result = await runCli(args, root);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("--input");
      expect(result.stdout).toContain("--launch-payload");
    }
  });

  test("unknown command exits nonzero with native diagnostic and suggestion", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-unknown-"));
    dirs.push(root);
    const nope = await runCli(["nope"], root);
    expect(nope.code).toBe(1);
    expect(nope.stderr).toContain("unknown command");
    expect(nope.stderr).toContain("nope");

    const typo = await runCli(["inti"], root);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("unknown command");
    expect(typo.stderr).toContain("inti");
    expect(typo.stderr).toMatch(/Did you mean.*init/i);
  });

  test("unknown option exits nonzero with a native diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-opt-"));
    dirs.push(root);
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');
    const result = await runCli(["run", "hi", "--not-a-real-flag"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown option");
  });

  test("run without a workflow name exits nonzero", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-missing-"));
    dirs.push(root);
    const result = await runCli(["run"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/missing required argument/i);
  });

  test("workflow without import prints generated workflow help as an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-wf-"));
    dirs.push(root);
    const result = await runCli(["workflow"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).toContain("import");
  });
});

describe("cli run", () => {
  test("run resolves workflows via HERDR_WORKFLOWS_REPO_ROOT from a foreign cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hwf-cli-elsewhere-"));
    dirs.push(root, elsewhere);
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');

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
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');

    const result = await runCli(["run", "hi"], elsewhere);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("run treats an empty HERDR_WORKFLOWS_REPO_ROOT as unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');

    const result = await runCli(["run", "hi"], root, { HERDR_WORKFLOWS_REPO_ROOT: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("run accepts repeated and equals-form --input flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-inputs-"));
    dirs.push(root);
    await writeWorkflow(
      root,
      "echo-inputs",
      [
        "version: v1alpha1",
        "inputs:",
        "  a: text",
        "  b: text",
        "steps:",
        `  - run: ${JSON.stringify([
          process.execPath,
          "-e",
          'process.exit(Bun.argv.slice(-2).join("-") === "one-two" ? 0 : 1)',
          "{{inputs.a}}",
          "{{inputs.b}}",
        ])}`,
        "",
      ].join("\n"),
    );

    const result = await runCli(["run", "echo-inputs", "--input", "a=one", "--input=b=two"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("run rejects invalid --input values", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-bad-input-"));
    dirs.push(root);
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');

    const result = await runCli(["run", "hi", "--input", "novalue"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid");
    expect(result.stderr).toContain("--input expects name=value");
    expect(result.stderr).toContain("novalue");
  });

  test("launch-payload seeds inputs and --input overrides them", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-payload-"));
    dirs.push(root);
    await writeWorkflow(
      root,
      "demo",
      [
        "version: v1alpha1",
        "inputs:",
        "  a: text",
        "steps:",
        `  - run: ${JSON.stringify([
          process.execPath,
          "-e",
          'process.exit(Bun.argv.at(-1) === "2" ? 0 : 1)',
          "{{inputs.a}}",
        ])}`,
        "",
      ].join("\n"),
    );

    const result = await runCli(
      ["run", "demo", "--launch-payload", "--input", "a=2"],
      root,
      { HERDR_WORKFLOWS_REPO_ROOT: root },
      JSON.stringify({ name: "demo", inputs: { a: "1" } }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/1]");
  });

  test("detached launch-payload rejects missing dynamic domain snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-missing-domain-"));
    dirs.push(root);
    const script = join(root, "discover.sh");
    await writeFile(script, "#!/bin/sh\necho main\n");
    await Bun.spawn(["chmod", "+x", script]).exited;
    await writeWorkflow(
      root,
      "dyn",
      [
        "version: v1alpha1",
        "inputs:",
        "  branch:",
        "    type: choice",
        "    options:",
        `      run: [${JSON.stringify(script)}]`,
        "steps:",
        '  - run: [echo, "{{inputs.branch}}"]',
        "",
      ].join("\n"),
    );

    const result = await runCli(
      ["run", "dyn", "--launch-payload"],
      root,
      { HERDR_WORKFLOWS_REPO_ROOT: root },
      JSON.stringify({ name: "dyn", inputs: { branch: "main" } }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/missing launch payload domain snapshot/);
  });

  test("workflow inspect help and protocol independence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-inspect-"));
    dirs.push(root);
    await writeWorkflow(
      root,
      "inspect-me",
      [
        "version: v1alpha1",
        "inputs:",
        "  mode: [create, delete]",
        "  branch: { type: text, when: '{{inputs.mode}} == \"create\"' }",
        "steps:",
        '  - run: [echo, "{{inputs.mode}}"]',
        '  - run: [echo, "{{inputs.branch}}"]',
        "    when: '{{inputs.mode}} == \"create\"'",
        "",
      ].join("\n"),
    );

    const help = await runCli(["workflow", "inspect", "--help"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--input");
    expect(help.stdout).toContain("--resolve");

    const inspected = await runCli(
      ["workflow", "inspect", "inspect-me", "--input", "mode=create"],
      root,
      {
        HERDR_WORKFLOWS_REPO_ROOT: root,
        HERDR_SOCKET_PATH: "/tmp/hwf-missing-herdr.sock",
      },
    );
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain('when: {{inputs.mode}} == "create"');
    expect(inspected.stdout).toContain("branch:");
  });

  test("run rejects herdr protocol before missing-input failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-repo-"));
    dirs.push(root);
    await writeWorkflow(
      root,
      "needs",
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
    await writeWorkflow(root, "hi", 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n');

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

describe("cli picker", () => {
  test("rejects herdr protocol mismatch before mounting UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-picker-proto-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });

    await withPingSocket(
      { protocol: HERDR_PROTOCOL + 1, version: MIN_HERDR_VERSION },
      async (socketPath) => {
        const result = await runCli(["picker"], root, {
          HERDR_WORKFLOWS_REPO_ROOT: root,
          HERDR_SOCKET_PATH: socketPath,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("herdr protocol mismatch");
        expect(result.stderr).toContain(`pinned=${HERDR_PROTOCOL}`);
      },
    );
  });

  test("protocol mismatch retains precedence over concurrent picker import failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-picker-import-race-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });

    const mockDir = await mkdtemp(join(tmpdir(), "hwf-cli-picker-import-fail-"));
    dirs.push(mockDir);
    const preload = join(mockDir, "preload.ts");
    const pickerAbs = join(import.meta.dir, "..", "..", "src", "tui", "picker.ts");
    await writeFile(
      preload,
      [
        'import { mock } from "bun:test";',
        `mock.module(${JSON.stringify(pickerAbs)}, () => {`,
        '  throw new Error("forced picker import failure");',
        "});",
        "",
      ].join("\n"),
    );

    await withPingSocket(
      { protocol: HERDR_PROTOCOL + 1, version: MIN_HERDR_VERSION },
      async (socketPath) => {
        const result = await runCli(
          ["picker"],
          root,
          {
            HERDR_WORKFLOWS_REPO_ROOT: root,
            HERDR_SOCKET_PATH: socketPath,
          },
          undefined,
          preload,
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("herdr protocol mismatch");
        expect(result.stderr).toContain(`pinned=${HERDR_PROTOCOL}`);
        expect(result.stderr).not.toContain("forced picker import failure");
      },
    );
  });
});

describe("cli launch", () => {
  test("rejects herdr protocol mismatch before opening the picker pane", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-launch-proto-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });

    await withPingSocket(
      { protocol: HERDR_PROTOCOL + 1, version: MIN_HERDR_VERSION },
      async (socketPath) => {
        const result = await runCli(["launch"], root, { HERDR_SOCKET_PATH: socketPath });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("herdr protocol mismatch");
        expect(result.stderr).toContain(`pinned=${HERDR_PROTOCOL}`);
      },
    );
  });

  test("forwards repo root and plugin context after protocol preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-launch-env-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });

    const methods: string[] = [];
    let openedEnv: Record<string, string> | undefined;
    const dir = await mkdtemp(join(tmpdir(), "hwf-cli-launch-env-sock-"));
    dirs.push(dir);
    const socketPath = join(dir, "herdr.sock");
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\n")) return;
        const req = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as {
          id: string;
          method: string;
          params?: { env?: Record<string, string> };
        };
        methods.push(req.method);
        if (req.method === "ping") {
          socket.end(
            `${JSON.stringify({
              id: req.id,
              result: { type: "pong", protocol: HERDR_PROTOCOL, version: MIN_HERDR_VERSION },
            })}\n`,
          );
          return;
        }
        if (req.method === "plugin.pane.open") {
          openedEnv = req.params?.env;
          socket.end(`${JSON.stringify({ id: req.id, result: { type: "ok" } })}\n`);
          return;
        }
        socket.end(
          `${JSON.stringify({ id: req.id, error: { code: "unexpected", message: req.method } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => resolve());
      server.on("error", reject);
    });
    try {
      const ctx = JSON.stringify({ focused_pane_cwd: root, selected_text: "sel" });
      const result = await runCli(["launch"], root, {
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PLUGIN_CONTEXT_JSON: ctx,
      });
      expect(result.code).toBe(0);
      expect(methods).toEqual(["ping", "plugin.pane.open"]);
      expect(openedEnv?.HERDR_WORKFLOWS_REPO_ROOT).toBe(root);
      expect(openedEnv?.HERDR_PLUGIN_CONTEXT_JSON).toBe(ctx);
    } finally {
      server.close();
    }
  });
});

describe("cli workflow import", () => {
  test("rejects invalid --to choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-to-bad-"));
    dirs.push(root);
    const result = await runCli(["workflow", "import", "x", "--to", "home", "--yes"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid|choices/i);
    expect(result.stderr).toContain("home");
  });

  test("accepts --to=repo with non-TTY preapproval flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-to-ok-"));
    dirs.push(root);
    const yaml = 'version: v1alpha1\nsteps:\n  - run: "printf ok"\n';
    const payload = encodePayload([{ name: "imported", yaml }]);
    const result = await runCli(["workflow", "import", payload, "--yes", "--to=repo"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote");
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

  test("rejects an invalid --port before starting a server", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-port-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    const result = await runCli(["web", "--port", "0", "--no-open"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid");
    expect(result.stderr).toContain("--port expects an integer between 1 and 65535");
  });

  test("validates equals-form --port", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-web-eq-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    const result = await runCli(["web", "--port=0", "--no-open"], root, {
      HERDR_WORKFLOWS_REPO_ROOT: root,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--port expects an integer between 1 and 65535");
  });
});

describe("cli response check", () => {
  async function withResponse(text: string): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(tmpdir(), "hwf-cli-verdict-"));
    dirs.push(root);
    const file = join(root, "response.txt");
    await writeFile(file, text);
    return { root, file };
  }

  test("a matching final line exits zero and prints the verdict", async () => {
    const { root, file } = await withResponse("Reasoning about the diff.\n\nAPPROVE\n");
    const result = await runCli(["response", "check", file, "--one-of", "APPROVE,REJECT"], root);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("APPROVE");
    expect(result.stderr).toBe("");
  });

  test("a decorated verdict exits nonzero naming the line and the tokens", async () => {
    const { root, file } = await withResponse("APPROVE — with reservations\n");
    const result = await runCli(["response", "check", file, "--one-of", "APPROVE,REJECT"], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("APPROVE — with reservations");
    expect(result.stderr).toContain("APPROVE, REJECT");
    expect(result.stdout).toBe("");
  });

  test("a missing or empty file exits nonzero naming the path", async () => {
    const { root, file } = await withResponse("   \n\n");
    const empty = await runCli(["response", "check", file, "--one-of", "APPROVE"], root);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain(file);

    const gone = join(root, "nope.txt");
    const missing = await runCli(["response", "check", gone, "--one-of", "APPROVE"], root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(gone);
  });

  test("bad token lists are rejected with the expect.one_of rules", async () => {
    const { root, file } = await withResponse("APPROVE\n");
    const lower = await runCli(["response", "check", file, "--one-of", "approve"], root);
    expect(lower.code).toBe(1);
    expect(lower.stderr).toContain("[A-Z][A-Z0-9_]{0,31}");

    const dup = await runCli(["response", "check", file, "--one-of", "APPROVE,APPROVE"], root);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("duplicate verdict token 'APPROVE'");

    const blank = await runCli(["response", "check", file, "--one-of", " , "], root);
    expect(blank.code).toBe(1);
    expect(blank.stderr).toContain("at least one verdict token");

    const noFlag = await runCli(["response", "check", file], root);
    expect(noFlag.code).not.toBe(0);
    expect(noFlag.stderr).toContain("--one-of");
  });

  test("the check runs offline with no herdr socket", async () => {
    const { root, file } = await withResponse("APPROVE\n");
    const result = await runCli(["response", "check", file, "--one-of", "APPROVE"], root, {
      HERDR_SOCKET_PATH: join(root, "missing.sock"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("APPROVE");
  });
});
