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
  dirs.push(root);
  const dir = join(root, ".hwf", "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, ".hwf", "config.yaml"), "agents:\n  claude: [claude, '{prompt}']\n");
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
    const data = (await res.json()) as { agents: string[] };
    expect(data.agents).toContain("claude");
  });
});

describe("web visual round-trip", () => {
  test("parse then format returns readable YAML with blank-line separated steps", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const yaml =
      "steps:\n  - shell: echo hi\n    stdin: '{pane}'\n  - agent: claude\n    prompt: go\n";
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
    expect(formatted.text).toContain('stdin: "{pane}"');
    expect(formatted.text).toContain("\n\n  - agent: claude");
  });

  test("format rejects a doc with no steps", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/format`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ doc: { steps: [] } }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("web server writes", () => {
  test("validate does not write", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "buf", text: "steps:\n  - shell: echo hi\n" }),
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
        text: "steps:\n  - shell: echo {pane}\n",
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/step 1/);
    expect(await Bun.file(join(root, ".hwf", "workflows", "bad.yaml")).exists()).toBe(false);
  });

  test("valid save writes", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "good", scope: "repo", text: "steps:\n  - shell: echo hi\n" }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await Bun.file(join(root, ".hwf", "workflows", "good.yaml")).exists()).toBe(true);
  });

  test("promote refuses clobber without force, overwrites with force", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "shared.yaml"), "steps:\n  - shell: echo repo\n");
    // point HOME at a temp so global writes stay isolated
    const home = await mkdtemp(join(tmpdir(), "herdr-workflows-home-"));
    dirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await mkdir(join(home, ".hwf", "workflows"), { recursive: true });
      await writeFile(
        join(home, ".hwf", "workflows", "shared.yaml"),
        "steps:\n  - shell: echo global\n",
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
