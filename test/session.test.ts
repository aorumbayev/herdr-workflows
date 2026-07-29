import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_BYTE_LIMIT } from "../src/limits";
import {
  extractSessionTranscript,
  readClaudeTranscript,
  slug,
  transcriptText,
} from "../src/session";
import { bunAllocStdoutArgv } from "./host-executable";

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
    expect(extractSessionTranscript(jsonl)).toBe("user:\nhello\n\nassistant:\nworld");
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
            "bun",
            "-e",
            "process.stdout.write(['pane='+process.env.HWF_TRANSCRIPT_PANE_ID,'kind='+process.env.HWF_TRANSCRIPT_AGENT_KIND,'cwd='+process.env.HWF_TRANSCRIPT_CWD,'sk='+process.env.HWF_TRANSCRIPT_SESSION_KIND,'sv='+process.env.HWF_TRANSCRIPT_SESSION_VALUE].join(' '))",
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
          command: ["bun", "-e", "process.stdout.write(process.env.HWF_TRANSCRIPT_CWD ?? '')"],
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
        { codex: { command: ["bun", "-e", "process.stderr.write('boom'); process.exit(2)"] } },
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
        { codex: { command: ["bun", "-e", "void 0"] } },
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
    await expect(
      transcriptText(
        "p",
        { claude: { command: bunAllocStdoutArgv(CAPTURE_BYTE_LIMIT + 1) } },
        {
          invocationCwd: root,
          getInfo: async () => ({ agent: "claude", sessionId: "s", cwd: root }),
        },
      ),
    ).rejects.toThrow(new RegExp(`exceeded ${CAPTURE_BYTE_LIMIT} byte limit`));
  });
});
