import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type RpcCall = { method: string; params: Record<string, unknown> };

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RpcCall[];
};

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXAMPLES_DIR = join(REPO_ROOT, "examples");
const SOURCE_CLI = join(REPO_ROOT, "src", "cli.ts");

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function copyExamples(repoRoot: string): Promise<void> {
  const destination = join(repoRoot, ".hwf", "workflows");
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(EXAMPLES_DIR)) {
    if (name.endsWith(".yaml")) {
      await writeFile(join(destination, name), await readFile(join(EXAMPLES_DIR, name), "utf8"));
    }
  }
}

async function writeCommands(root: string): Promise<{
  bin: string;
  agent: string;
  clipboard: string;
}> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const agent = join(bin, "fake-agent");
  const clipboard = join(root, "clipboard.txt");
  await executable(
    agent,
    `#!/bin/sh
path=$1
prompt=$2
[ -z "$path" ] && exit 0
case "$prompt" in
  *"prompt rewriter"*) reply="refined prompt" ;;
  *"session-handoff writer"*)
    reply="deterministic handoff"
    mkdir -p .hwf/tmp
    printf '%s' "$reply" > .hwf/tmp/handoff.md
    ;;
  *"Review this diff"*)
    reply="one finding, reported above

\${HWF_E2E_REVIEW_VERDICT:-APPROVE}"
    ;;
  *"Critique the proposal"*)
    reply="the plan skips verification

\${HWF_E2E_CRITIQUE_VERDICT:-APPROVE}"
    ;;
  *"Write a short, concrete proposal"*) reply="deterministic proposal" ;;
  *"Revise your proposal"*) reply="deterministic revision" ;;
  *) reply="managed reply" ;;
esac
printf '%s' "$reply" > "$path"
`,
  );
  await executable(
    join(bin, "fake-transcript"),
    "#!/bin/sh\nprintf 'deterministic transcript\\n'\n",
  );
  await executable(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "-C" ]; then shift 2; fi
for last in "$@"; do :; done
case "$1 $2" in
  "diff --quiet") [ "\${HWF_E2E_GIT_DIRTY:-0}" = 0 ] ;;
  "diff HEAD")
    [ "\${HWF_E2E_GIT_DIRTY:-0}" = 1 ] && printf '%s\\n' 'diff --git a/x b/x' '+changed'
    exit 0 ;;
  "show-ref --verify") [ "\${HWF_E2E_BRANCH_EXISTS:-0}" = 1 ] ;;
  "rev-parse --git-dir") echo .git ;;
  "rev-parse --show-toplevel") pwd ;;
  "remote "*) printf 'origin\\nupstream\\n' ;;
  "for-each-ref "*)
    case "$last" in
      refs/remotes/*) printf '%s/main\\n%s/release\\n' "\${last#refs/remotes/}" "\${last#refs/remotes/}" ;;
      *) printf 'main\\nfeature-seed\\n' ;;
    esac ;;
  "log --oneline") printf 'abc1234 seed commit on %s\\n' "$last" ;;
  "worktree remove") exit 0 ;;
  "branch -d") exit "\${HWF_E2E_BRANCH_UNMERGED:-0}" ;;
  *) exit 2 ;;
esac
`,
  );
  const clipboardCommand = `#!/bin/sh
printf '%s:' "$(basename "$0")" > "$HWF_E2E_CLIPBOARD"
cat >> "$HWF_E2E_CLIPBOARD"
`;
  for (const name of ["pbcopy", "wl-copy", "xclip", "xsel"]) {
    await executable(join(bin, name), clipboardCommand);
  }
  await executable(
    join(bin, "herdr"),
    `#!/bin/sh
if [ "$1 $2" = "agent get" ]; then
  target=$3
  status=done
  [ -f "$HWF_E2E_AGENT_STATE/$target" ] && status=$(cat "$HWF_E2E_AGENT_STATE/$target")
  [ "$status" = working ] && echo done > "$HWF_E2E_AGENT_STATE/$target"
  printf '{"result":{"agent":{"name":"%s","pane_id":"%s","agent":"custom","agent_status":"%s","interactive_ready":true,"launch_pending":false,"cwd":"%s","agent_session":{"kind":"fake","value":"session"}}}}\\n' "$target" "$target" "$status" "$HERDR_WORKFLOWS_REPO_ROOT"
  exit 0
fi
case "$1 $2" in
  "notification show"|"pane report-metadata") exit 0 ;;
  "agent list")
    pane=
    [ "\${HWF_E2E_AGENT_ON_OPEN:-0}" = 1 ] && pane=$(cat "$HWF_E2E_AGENT_STATE/opened-pane" 2>/dev/null || true)
    if [ -n "$pane" ]; then
      printf '{"result":{"agents":[{"name":"claude-%s","pane_id":"%s","agent":"claude","focused":true}]}}\\n' \\
        "$pane" "$pane"
    else
      printf '{"result":{"agents":[]}}\\n'
    fi
    exit 0 ;;
  "worktree list")
    printf '{"result":{"source":{"repo_root":"%s"},"worktrees":[{"is_linked_worktree":true,"branch":"feature-seed","path":"%s-wt","open_workspace_id":"%s"}]}}\\n' \\
      "$HERDR_WORKFLOWS_REPO_ROOT" "$HERDR_WORKFLOWS_REPO_ROOT" "\${HWF_E2E_WORKTREE_WS:-w2}"
    exit 0 ;;
  "worktree remove") exit 0 ;;
esac
printf 'unsupported fake herdr command: %s\\n' "$*" >&2
exit 2
`,
  );
  return { bin, agent, clipboard };
}

async function writeConfig(repoRoot: string, agent: string): Promise<void> {
  await writeFile(
    join(repoRoot, ".hwf", "config.yaml"),
    `profiles:
  deterministic:
    kind: custom
    args: [${JSON.stringify(agent)}]
default_profile: deterministic
transcripts:
  custom:
    command: [fake-transcript]
`,
  );
}

function paneInfo(paneId: string, tabId = "w1:t1"): Record<string, unknown> {
  return { pane_id: paneId, tab_id: tabId, workspace_id: "w1" };
}

export class ExampleHarness {
  readonly calls: RpcCall[] = [];
  readonly root: string;
  readonly repoRoot: string;
  readonly socketPath: string;
  readonly clipboard: string;
  private readonly bin: string;
  private readonly agent: string;
  private readonly server: Server;
  private nextPane = 2;
  private nextTab = 2;
  private agents = new Map<string, string[]>();
  private runEnv: Record<string, string> = {};

  private constructor(root: string, bin: string, agent: string, clipboard: string, server: Server) {
    this.root = root;
    this.repoRoot = join(root, "repo");
    this.socketPath = join(root, "herdr.sock");
    this.bin = bin;
    this.agent = agent;
    this.clipboard = clipboard;
    this.server = server;
  }

  static async create(): Promise<ExampleHarness> {
    const root = await mkdtemp(join(tmpdir(), "hwf-examples-e2e-"));
    const repoRoot = join(root, "repo");
    await Promise.all([mkdir(repoRoot), mkdir(join(root, "agent-state"))]);
    const { bin, agent, clipboard } = await writeCommands(root);
    await copyExamples(repoRoot);
    await writeConfig(repoRoot, agent);
    const server = createServer();
    const harness = new ExampleHarness(root, bin, agent, clipboard, server);
    server.on("connection", (socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString("utf8");
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(text.slice(0, newline)) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        void harness.respond(request).then((result) => {
          socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(harness.socketPath, resolve);
    });
    return harness;
  }

  private async respond(request: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const { method, params } = request;
    this.calls.push({ method, params });
    if (method === "ping") return { type: "pong", protocol: 19, version: "0.8.0" };
    if (method === "tab.create") {
      const tabId = `w1:t${this.nextTab++}`;
      const paneId = `w1:p${this.nextPane++}`;
      return {
        type: "tab_created",
        tab: { tab_id: tabId, workspace_id: "w1" },
        root_pane: paneInfo(paneId, tabId),
      };
    }
    if (method === "pane.split") {
      return { type: "pane_info", pane: paneInfo(`w1:p${this.nextPane++}`) };
    }
    if (method === "pane.process_info") {
      return {
        type: "pane_process_info",
        process_info: {
          pane_id: params.pane_id,
          shell_pid: 100,
          foreground_process_group_id: 100,
          foreground_processes: [{ pid: 100, name: "sh", argv: ["sh"], argv0: "sh" }],
          tty: "/dev/null",
        },
      };
    }
    if (method === "agent.get") {
      const target = String(params.target);
      const status = await readFile(join(this.root, "agent-state", target), "utf8").catch(
        () => "done",
      );
      return {
        type: "agent_info",
        agent: {
          name: target,
          pane_id: target,
          agent: "custom",
          agent_status: status,
          interactive_ready: true,
          launch_pending: false,
        },
      };
    }
    if (method === "worktree.create" || method === "worktree.open") {
      const tabId = `w1:t${this.nextTab++}`;
      const paneId = `w1:p${this.nextPane++}`;
      if (method === "worktree.open") {
        await writeFile(join(this.root, "agent-state", "opened-pane"), paneId);
      }
      return {
        type: method === "worktree.create" ? "worktree_created" : "worktree_opened",
        workspace: { workspace_id: "w1", label: String(params.label ?? "") },
        tab: { tab_id: tabId, workspace_id: "w1" },
        root_pane: paneInfo(paneId, tabId),
      };
    }
    if (method === "tab.rename" || method === "tab.focus") return { type: "ok" };
    if (method === "agent.start" && params.args === undefined) {
      const name = String(params.name);
      await writeFile(join(this.root, "agent-state", name), "idle");
      return {
        type: "agent_started",
        agent: {
          name,
          pane_id: params.pane_id,
          agent: String(params.kind),
          agent_status: "idle",
          interactive_ready: true,
          launch_pending: false,
        },
      };
    }
    if (method === "agent.start") {
      const name = String(params.name);
      const args = params.args;
      if (params.kind !== "custom" || !Array.isArray(args) || args[0] !== this.agent) {
        throw new Error("agent.start did not use the configured custom profile");
      }
      this.agents.set(name, args.map(String));
      await writeFile(join(this.root, "agent-state", name), "idle");
      return {
        type: "agent_started",
        agent: {
          name,
          pane_id: params.pane_id,
          agent: "custom",
          agent_status: "idle",
          interactive_ready: true,
          launch_pending: false,
        },
        argv: args,
      };
    }
    if (method === "agent.prompt") {
      const target = String(params.target);
      const prompt = String(params.text ?? "");
      const paths = [...prompt.matchAll(/absolute path ([^\s,]+)/g)];
      const responsePath = paths.at(-1)?.[1] ?? "";
      const argv = this.agents.get(target);
      if (!argv) throw new Error(`unknown fake agent ${target}`);
      const proc = Bun.spawn([argv[0]!, responsePath, prompt], {
        cwd: this.repoRoot,
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, ...this.runEnv },
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (exitCode !== 0) throw new Error(stderr || `fake agent exited ${exitCode}`);
      // One-shot: the fake herdr CLI serves `working` once, then flips the state to done.
      await writeFile(join(this.root, "agent-state", target), "working");
      return {
        type: "agent_prompted",
        agent: { name: target, pane_id: target, agent_status: "done" },
      };
    }
    if (method === "notification.show") {
      return { type: "notification_show", shown: true, reason: null };
    }
    if (method === "pane.close" || method === "tab.close") return { type: "ok" };
    throw new Error(`unsupported fake Herdr method: ${method}`);
  }

  async run(
    name: string,
    inputs: Record<string, string>,
    env: Record<string, string> = {},
  ): Promise<RunResult> {
    const callOffset = this.calls.length;
    this.runEnv = env;
    const args = [process.execPath, SOURCE_CLI, "run", name];
    for (const [key, value] of Object.entries(inputs)) args.push("--input", `${key}=${value}`);
    const proc = Bun.spawn(args, {
      cwd: this.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        PATH: `${this.bin}${delimiter}${process.env.PATH ?? ""}`,
        HERDR_BIN_PATH: join(this.bin, "herdr"),
        HERDR_CLIENT_SOCKET_PATH: join(this.root, "client.sock"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_PLUGIN_CONFIG_DIR: join(this.root, "plugin-config"),
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
          workspace_id: "w1",
          tab_id: "w1:t1",
          focused_pane_id: "w1:p1",
          cwd: this.repoRoot,
        }),
        HERDR_PLUGIN_STATE_DIR: join(this.root, "state"),
        HERDR_SOCKET_PATH: this.socketPath,
        HERDR_TAB_ID: "w1:t1",
        HERDR_WORKFLOWS_REPO_ROOT: this.repoRoot,
        HERDR_WORKSPACE_ID: "w1",
        HWF_E2E_CLIPBOARD: this.clipboard,
        HWF_E2E_AGENT_STATE: join(this.root, "agent-state"),
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, calls: this.calls.slice(callOffset) };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.root, { recursive: true, force: true });
  }
}
