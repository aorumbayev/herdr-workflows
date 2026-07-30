import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../src/herdr";
import { CAPTURE_BYTE_LIMIT } from "../src/limits";
import {
  CoordinationError,
  generateAgentName,
  isCoordinationError,
  readManagedResponse,
  sizeToFirstRatio,
} from "../src/run/context";
import { assertFocusPolicy } from "../src/herdr-policy";
import { buildHwfEnv, mergeStepEnv, runArgvStep, runShellStep } from "../src/run/steps/shell";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "herdr-workflows-steps-"));
}

describe("command results", () => {
  test("argv success reports exit code and clears failed", async () => {
    const cwd = await tempDir();
    try {
      const result = await runArgvStep(
        ["bun", "-e", "process.stdout.write('out'); process.stderr.write('err')"],
        { cwd },
      );
      expect(result).toEqual({
        ok: true,
        stdout: "out",
        stderr: "err",
        exitCode: 0,
        timedOut: false,
        failed: false,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("nonzero exit still returns a full structured result", async () => {
    const cwd = await tempDir();
    try {
      const result = await runShellStep("printf nope >&2; exit 3", { cwd });
      expect(result.failed).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("nope");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("timeout terminates the command and names the deadline", async () => {
    const cwd = await tempDir();
    try {
      const result = await runShellStep("sleep 5", { cwd, timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
      expect(result.failed).toBe(true);
      expect(result.stderr).toBe("timed out after 0.2s");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("step environment", () => {
  test("inputs become HWF_<name>", () => {
    expect(buildHwfEnv({ branch: "main", count: 2 })).toEqual({
      HWF_branch: "main",
      HWF_count: "2",
    });
  });

  test("generated values replace inherited collisions and explicit env wins", () => {
    const merged = mergeStepEnv(
      { PATH: "/bin", HWF_branch: "stale" },
      { HWF_branch: "main" },
      { TOKEN: "t" },
    );
    expect(merged).toEqual({ PATH: "/bin", HWF_branch: "main", TOKEN: "t" });
  });
});

describe("assertFocusPolicy", () => {
  test("required explicit targets", () => {
    expect(assertFocusPolicy("pane.split", { direction: "right" })).toContain("target_pane_id");
    expect(
      assertFocusPolicy("pane.split", { direction: "right", target_pane_id: "w-pane-1" }),
    ).toBeUndefined();
    expect(assertFocusPolicy("tab.create", {})).toContain("workspace_id");
    expect(assertFocusPolicy("pane.current", { caller_pane_id: "w-pane-1" })).toBeUndefined();
    expect(assertFocusPolicy("pane.zoom", { pane_id: "" })).toContain("pane_id");
  });

  test("exactly-one and at-least-one selectors", () => {
    expect(assertFocusPolicy("layout.apply", { workspace_id: "w", tab_id: "t" })).toContain(
      "exactly one",
    );
    expect(assertFocusPolicy("layout.apply", { tab_id: "t" })).toBeUndefined();
    expect(assertFocusPolicy("worktree.list", {})).toContain("exactly one");
    expect(assertFocusPolicy("worktree.create", { cwd: "/repo" })).toBeUndefined();
    expect(assertFocusPolicy("layout.export", {})).toContain("one of");
    expect(assertFocusPolicy("layout.set_split_ratio", { pane_id: "p" })).toBeUndefined();
  });

  test("pane.swap accepts a direction form or an explicit pair", () => {
    expect(assertFocusPolicy("pane.swap", { direction: "right" })).toContain("direction");
    expect(assertFocusPolicy("pane.swap", { direction: "right", pane_id: "p" })).toBeUndefined();
    expect(
      assertFocusPolicy("pane.swap", { source_pane_id: "a", target_pane_id: "b" }),
    ).toBeUndefined();
  });

  test("pane.move destinations name their required identifiers", () => {
    expect(
      assertFocusPolicy("pane.move", { pane_id: "p", destination: { type: "tab", tab_id: "t" } }),
    ).toContain("target_pane_id");
    expect(
      assertFocusPolicy("pane.move", {
        pane_id: "p",
        destination: { type: "tab", tab_id: "t", split: "right", target_pane_id: "q" },
      }),
    ).toBeUndefined();
    expect(
      assertFocusPolicy("pane.move", { pane_id: "p", destination: { type: "new_tab" } }),
    ).toContain("workspace_id");
    expect(
      assertFocusPolicy("pane.move", { pane_id: "p", destination: { type: "new_workspace" } }),
    ).toBeUndefined();
  });

  test("unconstrained methods pass", () => {
    expect(assertFocusPolicy("notification.show", { title: "hi" })).toBeUndefined();
  });

  test("filter scopes stay optional while unclassified methods are refused", () => {
    expect(assertFocusPolicy("pane.list", {})).toBeUndefined();
    expect(assertFocusPolicy("tab.list", {})).toBeUndefined();
    expect(assertFocusPolicy("pane.rotate", {})).toContain("unclassified method");
    expect(assertFocusPolicy("pane.edges", {})).toContain("pane_id");
  });

  test("templated unrelated params do not waive selector presence", () => {
    expect(assertFocusPolicy("worktree.create", { branch: "{{inputs.branch}}" })).toContain(
      "exactly one",
    );
    expect(assertFocusPolicy("tab.create", { label: "{{inputs.l}}" })).toContain("workspace_id");
    expect(
      assertFocusPolicy("worktree.create", {
        cwd: "{{inputs.cwd}}",
        branch: "{{inputs.branch}}",
      }),
    ).toBeUndefined();
    expect(
      assertFocusPolicy("tab.create", {
        workspace_id: "{{context.workspace}}",
        label: "{{inputs.l}}",
      }),
    ).toBeUndefined();
  });
});

describe("coordination loss", () => {
  test("transport codes and messages are uncertain coordination", () => {
    expect(isCoordinationError(new HerdrError("closed", "pane.split: socket closed"))).toBe(true);
    expect(isCoordinationError(new HerdrError("no_socket", "HERDR_SOCKET_PATH is not set"))).toBe(
      true,
    );
    expect(
      isCoordinationError(
        new HerdrError("unreachable", "unreachable herdr at /tmp/x: pane.split: closed"),
      ),
    ).toBe(true);
    expect(isCoordinationError(new Error("read ECONNRESET"))).toBe(true);
    expect(isCoordinationError(new Error("write EPIPE"))).toBe(true);
    expect(isCoordinationError(new HerdrError("invalid_params", "bad ratio"))).toBe(false);
    expect(isCoordinationError("nope")).toBe(false);
  });

  test("the error says the action may still be active", () => {
    expect(new CoordinationError("agent", "socket closed").message).toContain(
      "may still be active",
    );
  });
});

describe("agent naming and split size", () => {
  test("names stay within the herdr identifier rule", () => {
    const name = generateAgentName("review_step", 2, "AB12cd");
    expect(name).toBe("review_step-ab12cd");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(generateAgentName(undefined, 3, "ff00")).toBe("step-3-ff00");
    const long = generateAgentName("a".repeat(40), 1, "ff00ff");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-ff00ff")).toBe(true);
  });

  test("size allocates the percentage to the created second pane", () => {
    expect(sizeToFirstRatio(40)).toBeCloseTo(0.6);
    expect(sizeToFirstRatio(99)).toBeCloseTo(0.01);
  });

  test("oversized managed response fails before read with source and limit", async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, "big.txt");
      await writeFile(path, Buffer.alloc(CAPTURE_BYTE_LIMIT + 1, 0x61));
      await expect(readManagedResponse(path)).rejects.toMatchObject({
        name: "CaptureLimitError",
        source: "managed response",
        limit: CAPTURE_BYTE_LIMIT,
        bytes: CAPTURE_BYTE_LIMIT + 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
