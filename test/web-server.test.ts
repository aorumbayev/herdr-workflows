import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebServer } from "../src/web/server";

const dirs: string[] = [];
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herdr-workflows-web-"));
  const plugin = await mkdtemp(join(tmpdir(), "herdr-workflows-plugin-"));
  dirs.push(root, plugin);
  process.env.HERDR_PLUGIN_CONFIG_DIR = plugin;
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(root, ".hwf", "config.yaml"),
    "profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n",
  );
  return root;
}

async function serve(root: string): Promise<{ base: string; token: string; s: WebServer }> {
  const s = await startWebServer({ repoRoot: root });
  servers.push(s);
  const u = new URL(s.url);
  return { base: `${u.protocol}//${u.host}`, token: s.token, s };
}

describe("web server security", () => {
  test("missing token rejected, no read", async () => {
    const root = await repo();
    const { base } = await serve(root);
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(403);
  });

  test("foreign origin rejected", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/state`, {
      headers: { "x-hwf-token": token, origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("valid token + host serves state", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/state`, { headers: { "x-hwf-token": token } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { profiles: string[] };
    expect(data.profiles).toContain("claude");
  });

  test("workflow GET rejects path-traversal names", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(
      `${base}/api/workflow?name=${encodeURIComponent("../../.hwf/config")}&scope=repo`,
      { headers: { "x-hwf-token": token } },
    );
    expect(res.status).toBe(400);
  });
});

const V1 = "version: v1alpha1\n";

describe("web visual round-trip", () => {
  test("parse then format returns readable YAML with blank-line separated steps", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const yaml = `${V1}steps:\n  - run: echo hi\n  - agent: go\n    using: claude\n`;
    const parsed = (await (
      await fetch(`${base}/api/parse`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ text: yaml }),
      })
    ).json()) as { ok: boolean; doc: unknown };
    expect(parsed.ok).toBe(true);
    const formatted = (await (
      await fetch(`${base}/api/format`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ doc: parsed.doc }),
      })
    ).json()) as { ok: boolean; text: string };
    expect(formatted.ok).toBe(true);
    expect(formatted.text).toContain("run: echo hi");
    expect(formatted.text).toContain("\n\n  - agent:");
    expect(formatted.text).toContain("using: claude");
  });

  test("format round-trips managed agent modes, nested pane, and combined-result fields", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const doc = {
      version: "v1alpha1",
      title: "Review",
      steps: [
        {
          id: "ask",
          agent: "summarize {{context.selection}}",
          using: "claude",
          pane: { open: "beside", size: 40, close: "success" },
        },
        {
          id: "follow",
          agent: "continue",
          target: "{{steps.ask.agent.name}}",
        },
        {
          herdr: "notification.show",
          params: {
            title: "done",
            body: "{{steps.ask.response}} pane={{steps.ask.pane_id}}",
          },
        },
      ],
    };
    const formatted = (await (
      await fetch(`${base}/api/format`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ doc }),
      })
    ).json()) as { ok: boolean; text?: string; error?: string };
    expect(formatted.ok).toBe(true);
    expect(formatted.text).toContain("title: Review");
    expect(formatted.text).toContain("using: claude");
    expect(formatted.text).toContain("target:");
    expect(formatted.text).toMatch(/"open"\s*:\s*"beside"|open: beside/);
    expect(formatted.text).toContain("herdr: notification.show");
    expect(formatted.text).toContain("steps.ask.response");
  });

  test("format rejects a doc with no steps", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/format`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ doc: { version: "v1alpha1", steps: [] } }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("web provenance and sensitivity", () => {
  test("state exposes repo/global provenance, title, and sensitive flags", async () => {
    const root = await repo();
    await writeFile(
      join(root, ".hwf", "workflows", "review.yaml"),
      `${V1}title: Review pane\ndescription: Uses transcript\nsteps:\n  - agent: "see {{context.transcript}}"\n    using: claude\n  - run: [echo, hi]\n`,
    );
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await mkdir(join(home, ".hwf", "workflows"), { recursive: true });
      await writeFile(
        join(home, ".hwf", "workflows", "global-tool.yaml"),
        `${V1}steps:\n  - herdr: pane.close\n    params: { pane_id: "w1:p1" }\n`,
      );
      const { base, token } = await serve(root);
      const data = (await (
        await fetch(`${base}/api/state`, { headers: { "x-hwf-token": token } })
      ).json()) as {
        entries: {
          name: string;
          title: string;
          provenance: string;
          flags: string[];
          description: string;
        }[];
      };
      const review = data.entries.find((e) => e.name === "review");
      expect(review?.title).toBe("Review pane");
      expect(review?.description).toContain("transcript");
      expect(review?.provenance).toBe("repo");
      expect(review?.flags).toEqual(expect.arrayContaining(["commands", "transcript"]));
      const global = data.entries.find((e) => e.name === "global-tool");
      expect(global?.provenance).toBe("global");
      expect(global?.flags).toEqual(expect.arrayContaining(["herdr:pane.close"]));
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("workflow GET reports the same sensitivity flags as state", async () => {
    const root = await repo();
    const text = `${V1}steps:\n  - agent: "x {{context.transcript_file}}"\n    using: claude\n`;
    await writeFile(join(root, ".hwf", "workflows", "t.yaml"), text);
    const { base, token } = await serve(root);
    const data = (await (
      await fetch(`${base}/api/workflow?name=t&scope=repo`, {
        headers: { "x-hwf-token": token },
      })
    ).json()) as { flags: string[]; valid: boolean };
    expect(data.valid).toBe(true);
    expect(data.flags).toContain("transcript");
  });

  test("buffer validate matches file loader errors for legacy keys", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const legacy = `${V1}steps:\n  - run: echo hi\n    out: x\n`;
    const buffer = (await (
      await fetch(`${base}/api/validate`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ name: "buf", text: legacy }),
      })
    ).json()) as { ok: boolean; error?: string };
    expect(buffer.ok).toBe(false);
    expect(buffer.error).toMatch(/out/);
    const saved = (await (
      await fetch(`${base}/api/workflow`, {
        method: "PUT",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ name: "legacy", scope: "repo", text: legacy }),
      })
    ).json()) as { ok: boolean; error?: string };
    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(/out/);
  });
});

describe("web server writes", () => {
  test("validate does not write", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "buf", text: `${V1}steps:\n  - run: echo hi\n` }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await Bun.file(join(root, ".hwf", "workflows", "buf.yaml")).exists()).toBe(false);
  });

  test("invalid save rejected, not written", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad",
        scope: "repo",
        text: `${V1}steps:\n  - run: true\n    out: x\n`,
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/Unrecognized key|Invalid input|out/);
    expect(await Bun.file(join(root, ".hwf", "workflows", "bad.yaml")).exists()).toBe(false);
  });

  test("valid save writes", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "good",
        scope: "repo",
        text: `${V1}steps:\n  - run: echo hi\n`,
      }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await Bun.file(join(root, ".hwf", "workflows", "good.yaml")).exists()).toBe(true);
  });

  test("promote refuses clobber without force, overwrites with force", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "shared.yaml"), `${V1}steps:\n  - run: echo repo\n`);
    // point HOME at a temp so global writes stay isolated
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await mkdir(join(home, ".hwf", "workflows"), { recursive: true });
      await writeFile(
        join(home, ".hwf", "workflows", "shared.yaml"),
        `${V1}steps:\n  - run: echo global\n`,
      );
      const { base, token } = await serve(root);
      const call = (force?: boolean) =>
        fetch(`${base}/api/promote`, {
          method: "POST",
          headers: { "x-hwf-token": token, "content-type": "application/json" },
          body: JSON.stringify({ name: "shared", from: "repo", to: "global", force }),
        });
      const clobber = await call();
      expect(clobber.status).toBe(409);
      expect(await Bun.file(join(home, ".hwf", "workflows", "shared.yaml")).text()).toContain(
        "global",
      );
      const forced = await call(true);
      expect(((await forced.json()) as { ok: boolean }).ok).toBe(true);
      expect(await Bun.file(join(home, ".hwf", "workflows", "shared.yaml")).text()).toContain(
        "repo",
      );
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
