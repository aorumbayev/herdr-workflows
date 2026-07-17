import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSessionTranscript, readClaudeTranscript, sessionText, slug } from "../src/session";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("session transcript", () => {
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

  test("configured command wins; env and cwd honored", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "herdr-workflows-sess-cwd-"));
    dirs.push(cwd);
    const out = await sessionText(
      "pane-1",
      {
        claude: [
          "sh",
          "-c",
          'printf \'id=%s cwd=%s agent=%s\' "$HERDR_WORKFLOWS_SESSION_ID" "$HERDR_WORKFLOWS_SESSION_CWD" "$HERDR_WORKFLOWS_SESSION_AGENT"',
        ],
      },
      {
        getInfo: async () => ({ agent: "claude", sessionId: "sid-9", cwd }),
      },
    );
    expect(out).toBe(`id=sid-9 cwd=${cwd} agent=claude`);
  });

  test("nonzero exit names agent with stderr tail", async () => {
    await expect(
      sessionText(
        "p",
        { codex: ["sh", "-c", "echo boom >&2; exit 2"] },
        { getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }) },
      ),
    ).rejects.toThrow(/session command for 'codex' failed:.*boom/);
  });

  test("empty stdout errors", async () => {
    await expect(
      sessionText(
        "p",
        { codex: ["sh", "-c", "true"] },
        { getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }) },
      ),
    ).rejects.toThrow(/session command for 'codex' printed nothing/);
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
    const out = await sessionText(
      "p",
      {},
      {
        projectsBase: base,
        getInfo: async () => ({ agent: "claude", sessionId, cwd }),
      },
    );
    expect(out).toBe("user:\nbuiltin");
  });

  test("no entry + other agent names fix", async () => {
    await expect(
      sessionText(
        "p",
        {},
        { getInfo: async () => ({ agent: "codex", sessionId: "s", cwd: process.cwd() }) },
      ),
    ).rejects.toThrow(
      /no sessions entry for 'codex' — add one to \.hwf\/config\.yaml \(built-in support: claude\)/,
    );
  });
});
