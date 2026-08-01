import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowsConfig } from "../src/config";
import { allocateRunId, getRunDetail, listRunHistory, parseHistoryAck } from "../src/history/store";
import type { RunnerDeps } from "../src/run/context";
import { createRunRecorder } from "../src/run/recorder";
import { runWorkflow } from "../src/run/runner";
import { loadWorkflow } from "../src/workflow/load";

const dirs: string[] = [];
let prevState: string | undefined;

beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "hwf-recorder-"));
  dirs.push(state);
  prevState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = state;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const baseConfig: WorkflowsConfig = {
  profiles: { claude: { kind: "claude" } },
  default_profile: "claude",
  transcripts: {},
};

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hwf-recorder-repo-"));
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.yaml`), body);
  }
  return root;
}

function mockDeps(): Partial<RunnerDeps> {
  return {
    herdrCall: async () => ({ type: "ok" }),
    notificationShow: async () => undefined,
    agentStatus: async () => "idle",
    agentInfo: async () => ({}),
    paneClose: async () => undefined,
    tabClose: async () => undefined,
    reportToken: async () => undefined,
    transcriptText: async () => "",
    sleep: async () => undefined,
    now: () => Date.now(),
  };
}

describe("createRunRecorder", () => {
  test("unavailable claim returns a null recorder and emits ack; run proceeds", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
    await mkdir(state, { recursive: true });
    await chmod(state, 0o755);
    const acks: string[] = [];
    const result = await runWorkflow({
      name: "m",
      repoRoot: root,
      config: baseConfig,
      ctx: { selection: "", cwd: root },
      deps: mockDeps(),
      onHistoryAck: (line) => acks.push(line),
    });
    expect(result.ok).toBe(true);
    expect(acks.some((line) => parseHistoryAck(line)?.state === "unavailable")).toBe(true);
    const listed = await listRunHistory({ checkout_root: null });
    expect(listed.ok === false || (listed.ok && listed.runs.length === 0)).toBe(true);
  });

  test("rejected claim returns error and emits ack", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const id = allocateRunId();
    const first = await createRunRecorder({
      workflow: await loadWorkflow("m", root, baseConfig),
      runId: id,
      checkoutRoot: root,
    });
    expect(first.ok).toBe(true);
    const acks: string[] = [];
    const second = await createRunRecorder({
      workflow: await loadWorkflow("m", root, baseConfig),
      runId: id,
      checkoutRoot: root,
      onAck: (line) => acks.push(line),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already claimed/);
    const ack = parseHistoryAck(acks[0] ?? "");
    expect(ack?.state).toBe("rejected");
    if (first.ok) first.recorder.dispose();
  });

  test("finished is idempotent", async () => {
    const root = await repoWith({
      m: `version: v1alpha1
steps:
  - run: [printf, hi]
`,
    });
    const created = await createRunRecorder({
      workflow: await loadWorkflow("m", root, baseConfig),
      checkoutRoot: root,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { recorder } = created;
    await recorder.finished("succeeded", { returns: { a: 1 } });
    await recorder.finished("failed", { error: "should-not-apply" });
    const listed = await listRunHistory({ checkout_root: await realpath(root) });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.runs[0]?.status).toBe("succeeded");
    const detail = await getRunDetail(listed.runs[0]!.id);
    expect(detail.kind).toBe("snapshot");
    if (detail.kind !== "snapshot") return;
    expect(detail.status).toBe("succeeded");
    recorder.dispose();
  });
});
