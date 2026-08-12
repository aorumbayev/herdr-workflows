import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_BYTE_LIMIT, TRANSCRIPT_FILE_BYTE_LIMIT } from "../../src/caps";
import {
  extractAgentTranscript,
  readClaudeTranscript,
  slug,
  transcriptText,
} from "../../src/transcript";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("transcript extractors", () => {
  test("slug replaces non-alnum with dashes", () => {
    expect(slug("/Users/x/y")).toBe("-Users-x-y");
  });

  test("extracts string and text-block content; skips tools and bad JSON", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { content: "hello" },
      }),
      "not-json",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "world" },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "tool_result", content: "skip me" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      }),
      JSON.stringify({ type: "system", message: { content: "ignore" } }),
    ].join("\n");
    expect(extractAgentTranscript(jsonl)).toBe("user:\nhello\n\nassistant:\nworld");
  });

  test("readClaudeTranscript loads fixture; missing file names path", async () => {
    const base = await mkdtemp(join(tmpdir(), "herdr-workflows-session-"));
    dirs.push(base);
    const cwd = "/Users/x/y";
    const sessionId = "abc123";
    const dir = join(base, slug(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(
      path,
      `${JSON.stringify({ type: "user", message: { content: "from file" } })}\n`,
    );
    expect(await readClaudeTranscript(cwd, sessionId, base)).toBe("user:\nfrom file");

    const missing = join(base, slug(cwd), "nope.jsonl");
    await expect(readClaudeTranscript(cwd, "nope", base)).rejects.toThrow(missing);
  });

  test("configured command wins; exact transcript env honored", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-sess-cwd-"));
    dirs.push(cwd);
    const out = await transcriptText(
      "pane-1",
      {
        claude: {
          command: [
            "sh",
            "-c",
            'printf \'pane=%s kind=%s cwd=%s sk=%s sv=%s\' "$HWF_TRANSCRIPT_PANE_ID" "$HWF_TRANSCRIPT_AGENT_KIND" "$HWF_TRANSCRIPT_CWD" "$HWF_TRANSCRIPT_SESSION_KIND" "$HWF_TRANSCRIPT_SESSION_VALUE"',
          ],
        },
      },
      {
        invocationCwd: "/fallback",
        getInfo: async () => ({
          agent: "claude",
          sessionId: "sid-9",
          sessionKind: "id",
          cwd,
        }),
      },
    );
    expect(out).toBe(`pane=pane-1 kind=claude cwd=${cwd} sk=id sv=sid-9`);
  });

  test("cwd falls back to invocation cwd when agent cwd absent", async () => {
    const invocationCwd = await mkdtemp(join(tmpdir(), "herdr-workflows-inv-cwd-"));
    dirs.push(invocationCwd);
    const out = await transcriptText(
      "pane-2",
      {
        codex: {
          command: ["sh", "-c", "printf '%s' \"$HWF_TRANSCRIPT_CWD\""],
        },
      },
      {
        invocationCwd,
        getInfo: async () => ({ agent: "codex", sessionId: "", cwd: "" }),
      },
    );
    expect(out).toBe(invocationCwd);
  });

  test("nonzero exit names kind with stderr tail", async () => {
    await expect(
      transcriptText(
        "p",
        { codex: { command: ["sh", "-c", "echo boom >&2; exit 2"] } },
        {
          invocationCwd: process.cwd(),
          getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }),
        },
      ),
    ).rejects.toThrow(/transcript command for 'codex' failed:.*boom/);
  });

  test("empty stdout errors", async () => {
    await expect(
      transcriptText(
        "p",
        { codex: { command: ["sh", "-c", "true"] } },
        {
          invocationCwd: process.cwd(),
          getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }),
        },
      ),
    ).rejects.toThrow(/transcript command for 'codex' printed nothing/);
  });

  test("no entry + claude uses builtin transcript", async () => {
    const base = await mkdtemp(join(tmpdir(), "herdr-workflows-session-"));
    dirs.push(base);
    const cwd = "/Users/x/y";
    const sessionId = "abc123";
    const dir = join(base, slug(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", message: { content: "builtin" } })}\n`,
    );
    const out = await transcriptText(
      "p",
      {},
      {
        invocationCwd: cwd,
        projectsBase: base,
        getInfo: async () => ({ agent: "claude", sessionId, cwd }),
      },
    );
    expect(out).toBe("user:\nbuiltin");
  });

  test("no entry + other kind names fix", async () => {
    await expect(
      transcriptText(
        "p",
        {},
        {
          invocationCwd: process.cwd(),
          getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }),
        },
      ),
    ).rejects.toThrow(/no transcript extractor for 'codex'/);
  });

  test("extractor output obeys shared capture cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-tcap-"));
    dirs.push(root);
    const script = join(root, "big.sh");
    await writeFile(
      script,
      `#!/bin/sh\ndd if=/dev/zero bs=${CAPTURE_BYTE_LIMIT + 1} count=1 2>/dev/null\n`,
    );
    await Bun.spawn(["chmod", "+x", script]).exited;
    await expect(
      transcriptText(
        "p",
        { claude: { command: [script] } },
        {
          invocationCwd: root,
          getInfo: async () => ({ agent: "claude", sessionId: "s", cwd: root }),
        },
      ),
    ).rejects.toThrow(new RegExp(`exceeded ${CAPTURE_BYTE_LIMIT} byte limit`));
  });

  test("oversized transcript file fails before read with source and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-tover-"));
    dirs.push(root);
    const cwd = "/repo";
    const sessionId = "big";
    const dir = join(root, slug(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(path, Buffer.alloc(TRANSCRIPT_FILE_BYTE_LIMIT + 1, 0x61));
    await expect(readClaudeTranscript(cwd, sessionId, root)).rejects.toMatchObject({
      name: "CaptureLimitError",
      source: "transcript file",
      limit: TRANSCRIPT_FILE_BYTE_LIMIT,
      bytes: TRANSCRIPT_FILE_BYTE_LIMIT + 1,
    });
  });

  test("raw file over the transcript cap succeeds when extracted text is small", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-traw-"));
    dirs.push(root);
    const cwd = "/repo";
    const sessionId = "bulky";
    const dir = join(root, slug(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    const toolNoise = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "x".repeat(CAPTURE_BYTE_LIMIT + 1) }],
      },
    });
    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "small ask" } }),
      toolNoise,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    await writeFile(path, jsonl);
    expect(await readClaudeTranscript(cwd, sessionId, root)).toBe(
      "user:\nsmall ask\n\nassistant:\nok",
    );
  });

  test("extracted text over the transcript cap fails with source and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-workflows-text-"));
    dirs.push(root);
    const cwd = "/repo";
    const sessionId = "verbose";
    const dir = join(root, slug(cwd));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(
      path,
      `${JSON.stringify({
        type: "user",
        message: { content: "y".repeat(CAPTURE_BYTE_LIMIT + 1) },
      })}\n`,
    );
    await expect(readClaudeTranscript(cwd, sessionId, root)).rejects.toMatchObject({
      name: "CaptureLimitError",
      source: "transcript",
      limit: CAPTURE_BYTE_LIMIT,
    });
  });
});
