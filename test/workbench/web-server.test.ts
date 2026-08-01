import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginStateDir } from "../../src/context";
import { allocateRunId, RunHistorySession } from "../../src/history";
import { workflowSchemaUrl } from "../../src/context";
import { parseWebRoute, runWorkbenchRoute } from "../../src/web/endpoint";
import { dropSource, startWebServer, type WebServer } from "../../src/web/server";

const dirs: string[] = [];
const servers: WebServer[] = [];
const prevPluginDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (prevPluginDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevPluginDir;
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

  test("favicon is public svg", async () => {
    const root = await repo();
    const { base } = await serve(root);
    const res = await fetch(`${base}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  test("valid token + host serves state", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/state`, { headers: { "x-hwf-token": token } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      profiles: string[];
      canonicalRepoRoot: string;
      workflowSchemaUrl: string;
    };
    expect(data.profiles).toContain("claude");
    expect(data.canonicalRepoRoot).toBe(root);
    expect(data.workflowSchemaUrl).toBe(workflowSchemaUrl());
    expect(data.workflowSchemaUrl).not.toContain("/main/");
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

  test("format round-trips on_failure herdr with nested params", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const doc = {
      version: "v1alpha1",
      steps: [{ run: "echo hi" }],
      on_failure: {
        herdr: "notification.show",
        params: {
          title: "handoff failed",
          body: "{{context.error.message}}",
          sound: "request",
        },
      },
    };
    const formatted = (await (
      await fetch(`${base}/api/format`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ doc }),
      })
    ).json()) as { ok: boolean; text?: string; error?: string };
    expect(formatted.ok).toBe(true);
    expect(formatted.text).toMatch(/\non_failure:\n {2}herdr:/);
    expect(formatted.text).toMatch(/\n {2}params:/);
    expect(formatted.text).not.toMatch(/\non_failure:\n {2}- /);
    const reparsed = (await (
      await fetch(`${base}/api/parse`, {
        method: "POST",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ text: formatted.text }),
      })
    ).json()) as {
      ok: boolean;
      doc?: { on_failure?: { herdr?: string; params?: Record<string, string> } };
      error?: string;
    };
    expect(reparsed.ok).toBe(true);
    expect(reparsed.doc?.on_failure?.herdr).toBe("notification.show");
    expect(reparsed.doc?.on_failure?.params).toMatchObject({
      title: "handoff failed",
      body: "{{context.error.message}}",
      sound: "request",
    });
  });
});

describe("web form sources", () => {
  test("schema endpoint serves the step keys, bounds, and enumerations", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/schema`, { headers: { "x-hwf-token": token } });
    expect(res.status).toBe(200);
    const schema = (await res.json()) as {
      properties: {
        steps: {
          items: {
            properties: Record<string, Record<string, unknown>>;
          };
        };
      };
    };
    const step = schema.properties.steps.items.properties;
    expect(Object.keys(step)).toContain("success_codes");
    expect(step.shell?.enum).toEqual(["sh", "bash", "zsh", "pwsh", "powershell", "cmd"]);
    const pane = step.pane as { properties: Record<string, Record<string, unknown>> };
    expect(pane.properties.size).toMatchObject({ type: "integer", minimum: 1, maximum: 99 });
    const retry = step.retry as { properties: Record<string, Record<string, unknown>> };
    expect(retry.properties.attempts).toMatchObject({ type: "integer", minimum: 2 });
  });

  test("methods endpoint serves allowed and denied methods with their reasons", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/methods`, { headers: { "x-hwf-token": token } });
    expect(res.status).toBe(200);
    const { methods } = (await res.json()) as {
      methods: {
        method: string;
        allowed: boolean;
        reason?: string;
        params: { required: string[]; properties: Record<string, { kinds: string[] }> };
      }[];
    };
    const show = methods.find((m) => m.method === "notification.show");
    expect(show?.allowed).toBe(true);
    expect(show?.params.required).toEqual(["title"]);
    expect(show?.params.properties.sound?.kinds).toEqual(["string"]);
    const denied = methods.find((m) => m.method === "server.stop");
    expect(denied?.allowed).toBe(false);
    expect(denied?.reason).toContain("would stop the server running the workflow");
  });

  test("format reports validation issues with their paths", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/format`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        doc: {
          version: "v1alpha1",
          steps: [
            { run: "echo hi", pane: { open: "beside" }, background: true, retry: { attempts: 3 } },
            { run: "echo hi", pane: { size: 200 } },
            { run: "echo hi", pane: { open: "tab", size: 40 } },
          ],
        },
      }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error: string;
      issues: { path: (string | number)[]; message: string }[];
    };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("retry");
    const retry = data.issues.find((i) => i.path.join(".") === "steps.0.retry");
    expect(retry?.message).toContain("retry");
    const outOfRange = data.issues.find((i) => i.path.join(".") === "steps.1.pane.size");
    expect(outOfRange?.message).toContain("<=99");
    const wrongOpen = data.issues.find((i) => i.path.join(".") === "steps.2.pane.size");
    expect(wrongOpen?.message).toContain("pane.size");
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

  test("validate does not execute dynamic-choice option commands", async () => {
    const root = await repo();
    const marker = join(root, "dynamic-choice-marker");
    const { base, token } = await serve(root);
    const text = `${V1}inputs:
  pick:
    type: choice
    options:
      run: [touch, ${JSON.stringify(marker).slice(1, -1)}]
steps:
  - run: [echo, "{{inputs.pick}}"]
`;
    const res = await fetch(`${base}/api/validate`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "dyn", text }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
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

  // A workflow written by the workbench must point an editor at the contract THIS build
  // implements; a moving ref would describe some other version's schema.
  test("PUT pins a missing schema pointer, and the next save from the returned base works", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "edit.yaml");
    const body = `${V1}steps:\n  - run: echo hi\n`;
    await writeFile(file, body);
    const { base, token } = await serve(root);
    const loaded = (await (
      await fetch(`${base}/api/workflow?name=edit&scope=repo`, {
        headers: { "x-hwf-token": token },
      })
    ).json()) as { base: string };
    const first = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        base: loaded.base,
        text: body,
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; base: string };
    const pointer = `# yaml-language-server: $schema=${workflowSchemaUrl()}`;
    const onDisk = await Bun.file(file).text();
    expect(onDisk).toBe(`${pointer}\n${body}`);

    // The baseline must name the bytes that landed, or normalization breaks the next save.
    const second = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        base: firstBody.base,
        text: onDisk.replace("echo hi", "echo again"),
      }),
    });
    expect(second.status).toBe(200);
    expect(await Bun.file(file).text()).toContain("echo again");
  });

  test("PUT replaces a pointer pinned elsewhere, wherever it sits, without duplicating it", async () => {
    const root = await repo();
    const stale =
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json";
    for (const [name, text] of [
      ["first", `${stale}\n${V1}steps:\n  - run: echo hi\n`],
      ["below", `${V1}${stale}\nsteps:\n  - run: echo hi\n`],
    ] as const) {
      const file = join(root, ".hwf", "workflows", `${name}.yaml`);
      await writeFile(file, text);
      const { base, token } = await serve(root);
      const loaded = (await (
        await fetch(`${base}/api/workflow?name=${name}&scope=repo`, {
          headers: { "x-hwf-token": token },
        })
      ).json()) as { base: string };
      const res = await fetch(`${base}/api/workflow`, {
        method: "PUT",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({
          name,
          scope: "repo",
          previousName: name,
          previousScope: "repo",
          base: loaded.base,
          text,
        }),
      });
      expect(res.status).toBe(200);
      const onDisk = await Bun.file(file).text();
      expect(onDisk.match(/yaml-language-server:/g)?.length).toBe(1);
      expect(onDisk).not.toContain("/main/");
      expect(onDisk.startsWith(`# yaml-language-server: $schema=${workflowSchemaUrl()}\n`)).toBe(
        true,
      );
      expect(onDisk).toContain("run: echo hi");
    }
  });

  test("PUT leaves an already-pinned pointer byte-identical", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "edit.yaml");
    const body = `# yaml-language-server: $schema=${workflowSchemaUrl()}\n${V1}steps:\n  - run: echo hi\n`;
    await writeFile(file, body);
    const { base, token } = await serve(root);
    const loaded = (await (
      await fetch(`${base}/api/workflow?name=edit&scope=repo`, {
        headers: { "x-hwf-token": token },
      })
    ).json()) as { base: string };
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        base: loaded.base,
        text: body,
      }),
    });
    expect(res.status).toBe(200);
    expect(await Bun.file(file).text()).toBe(body);
  });

  test("same-path PUT overwrites the workflow the buffer was loaded from", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "edit.yaml");
    await writeFile(file, `${V1}steps:\n  - run: echo old\n`);
    const { base, token } = await serve(root);
    const loaded = (await (
      await fetch(`${base}/api/workflow?name=edit&scope=repo`, {
        headers: { "x-hwf-token": token },
      })
    ).json()) as { base: string };
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        base: loaded.base,
        text: `${V1}steps:\n  - run: echo new\n`,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(await Bun.file(file).text()).toContain("echo new");
  });

  // Endpoint reuse makes two editors on one workflow the default, not the exception.
  test("same-path PUT refuses to discard a write the buffer never saw", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "edit.yaml");
    await writeFile(file, `${V1}steps:\n  - run: echo original\n`);
    const { base, token } = await serve(root);
    const loaded = (await (
      await fetch(`${base}/api/workflow?name=edit&scope=repo`, {
        headers: { "x-hwf-token": token },
      })
    ).json()) as { base: string };

    await writeFile(file, `${V1}steps:\n  - run: echo someone-elses-fix\n`);

    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        base: loaded.base,
        text: `${V1}steps:\n  - run: echo my-edit\n`,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; stale?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.stale).toBe(true);
    expect(body.error).toContain("changed");
    expect(await Bun.file(file).text()).toContain("someone-elses-fix");
  });

  test("same-path PUT with no baseline is refused rather than overwriting blind", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "edit.yaml");
    await writeFile(file, `${V1}steps:\n  - run: echo original\n`);
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "edit",
        scope: "repo",
        previousName: "edit",
        previousScope: "repo",
        text: `${V1}steps:\n  - run: echo blind\n`,
      }),
    });
    expect(res.status).toBe(409);
    expect(await Bun.file(file).text()).toContain("echo original");
  });

  test("PUT without a previous path refuses to clobber an existing workflow", async () => {
    const root = await repo();
    const file = join(root, ".hwf", "workflows", "mine.yaml");
    await writeFile(file, `${V1}steps:\n  - run: echo mine\n`);
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "mine",
        scope: "repo",
        text: `${V1}steps:\n  - run: echo theirs\n`,
      }),
    });
    expect(res.status).toBe(409);
    expect(await Bun.file(file).text()).toContain("echo mine");
  });

  test("rename PUT refuses occupied destination and leaves it unchanged", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "src.yaml"), `${V1}steps:\n  - run: echo src\n`);
    await writeFile(join(wdir, "taken.yaml"), `${V1}steps:\n  - run: echo taken\n`);
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "taken",
        scope: "repo",
        previousName: "src",
        previousScope: "repo",
        text: `${V1}steps:\n  - run: echo moved\n`,
      }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/already exists in repo/);
    expect(await Bun.file(join(wdir, "taken.yaml")).text()).toContain("echo taken");
    expect(await Bun.file(join(wdir, "src.yaml")).text()).toContain("echo src");
  });

  test("rename PUT moves the workflow in one request", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "old.yaml"), `${V1}steps:\n  - run: echo old\n`);
    const { base, token } = await serve(root);
    const put = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "fresh",
        scope: "repo",
        previousName: "old",
        previousScope: "repo",
        text: `${V1}steps:\n  - run: echo fresh\n`,
      }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true);
    expect(await Bun.file(join(wdir, "fresh.yaml")).text()).toContain("echo fresh");
    expect(await Bun.file(join(wdir, "old.yaml")).exists()).toBe(false);
  });

  test("concurrent renames into one destination let exactly one win", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "a.yaml"), `${V1}steps:\n  - run: echo a\n`);
    await writeFile(join(wdir, "b.yaml"), `${V1}steps:\n  - run: echo b\n`);
    const { base, token } = await serve(root);
    const move = (from: string) =>
      fetch(`${base}/api/workflow`, {
        method: "PUT",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({
          name: "shared",
          scope: "repo",
          previousName: from,
          previousScope: "repo",
          text: `${V1}steps:\n  - run: echo ${from}\n`,
        }),
      });
    const results = await Promise.all([move("a"), move("b")]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    const dest = await Bun.file(join(wdir, "shared.yaml")).text();
    const winner = dest.includes("echo a") ? "a" : "b";
    const loser = winner === "a" ? "b" : "a";
    expect(await Bun.file(join(wdir, `${winner}.yaml`)).exists()).toBe(false);
    expect(await Bun.file(join(wdir, `${loser}.yaml`)).text()).toContain(`echo ${loser}`);
  });

  test("rename PUT undoes its destination when the source cannot be removed", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    // A directory in the source's place makes the removal fail while the destination write
    // in the same directory still succeeds.
    await mkdir(join(wdir, "stuck.yaml"), { recursive: true });
    await writeFile(join(wdir, "stuck.yaml", "child"), "x");
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "PUT",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "moved",
        scope: "repo",
        previousName: "stuck",
        previousScope: "repo",
        text: `${V1}steps:\n  - run: echo moved\n`,
      }),
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/could not be removed/);
    expect(await Bun.file(join(wdir, "moved.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(wdir, "stuck.yaml", "child")).exists()).toBe(true);
  });

  test("a move that can neither remove its source nor undo its claim reports both", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    // Both paths refuse removal, so the source delete and the rollback each fail.
    await mkdir(join(wdir, "src.yaml", "child"), { recursive: true });
    await mkdir(join(wdir, "dest.yaml", "child"), { recursive: true });
    const res = await dropSource(join(wdir, "src.yaml"), join(wdir, "dest.yaml"), "src");
    expect(res.status).toBe(500);
    const data = (await res.json()) as { ok: boolean; error?: string; orphan?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/'src' could not be removed/);
    expect(data.error).toMatch(/could not be undone/);
    // The one failure that changed the disk, so clients can reconcile their view.
    expect(data.orphan).toContain("dest.yaml");
    expect(data.error).toContain("dest.yaml");
  });

  test("DELETE missing file is idempotent ok", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/workflow`, {
      method: "DELETE",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost", scope: "repo" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("DELETE reports real filesystem failure", async () => {
    const root = await repo();
    const wdir = join(root, ".hwf", "workflows");
    await writeFile(join(wdir, "stuck.yaml"), `${V1}steps:\n  - run: echo stuck\n`);
    const { chmod } = await import("node:fs/promises");
    await chmod(wdir, 0o555);
    try {
      const { base, token } = await serve(root);
      const res = await fetch(`${base}/api/workflow`, {
        method: "DELETE",
        headers: { "x-hwf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ name: "stuck", scope: "repo" }),
      });
      expect(res.status).toBe(500);
      const data = (await res.json()) as { ok: boolean; error?: string };
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/EACCES|permission denied/i);
      expect(await Bun.file(join(wdir, "stuck.yaml")).exists()).toBe(true);
    } finally {
      await chmod(wdir, 0o755);
    }
  });
});

describe("web share and import APIs", () => {
  test("share returns command and display provenance without encoding source", async () => {
    const root = await repo();
    await writeFile(
      join(root, ".hwf", "workflows", "handoff.yaml"),
      `${V1}steps:\n  - run: echo hi\n`,
    );
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/api/share?name=handoff&scope=repo`, {
      headers: { "x-hwf-token": token },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      command: string;
      entries: { name: string; yaml: string }[];
      provenance: { name: string; source: string }[];
    };
    expect(data.ok).toBe(true);
    expect(data.command.startsWith('hwf workflow import "')).toBe(true);
    expect(data.entries).toEqual([{ name: "handoff", yaml: `${V1}steps:\n  - run: echo hi\n` }]);
    expect(data.provenance).toEqual([{ name: "handoff", source: "repo" }]);
    expect(JSON.stringify(data.entries)).not.toContain('"source"');
  });

  test("import preview accepts command text and rejects old payloads", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const { encodePayload, formatImportCommand } = await import("../../src/workflow/share");
    const payload = encodePayload([{ name: "demo", yaml: `${V1}steps:\n  - run: x\n` }]);
    const ok = await fetch(`${base}/api/import/preview`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ text: formatImportCommand(payload) }),
    });
    expect(ok.status).toBe(200);
    const preview = (await ok.json()) as {
      ok: boolean;
      entries: { name: string; yaml: string }[];
      availability: { repo: { conflicts: unknown[] } };
    };
    expect(preview.ok).toBe(true);
    expect(preview.entries[0]?.name).toBe("demo");

    const old = Buffer.from(
      Bun.gzipSync(
        new TextEncoder().encode(
          JSON.stringify({ v: 1, name: "demo", body: `${V1}steps:\n  - run: x\n` }),
        ),
      ),
    ).toString("base64");
    const rejected = await fetch(`${base}/api/import/preview`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ text: old }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toMatch(/removed single-workflow/);
  });

  test("import requires replace-all when any destination conflicts", async () => {
    const root = await repo();
    await writeFile(join(root, ".hwf", "workflows", "demo.yaml"), `${V1}steps:\n  - run: mine\n`);
    const { base, token } = await serve(root);
    const { encodePayload } = await import("../../src/workflow/share");
    const text = encodePayload([{ name: "demo", yaml: `${V1}steps:\n  - run: new\n` }]);
    const conflict = await fetch(`${base}/api/import`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ text, scope: "repo" }),
    });
    expect(conflict.status).toBe(409);
    expect(await Bun.file(join(root, ".hwf", "workflows", "demo.yaml")).text()).toContain("mine");

    const replaced = await fetch(`${base}/api/import`, {
      method: "POST",
      headers: { "x-hwf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ text, scope: "repo", replaceAll: true }),
    });
    expect(replaced.status).toBe(200);
    expect(await Bun.file(join(root, ".hwf", "workflows", "demo.yaml")).text()).toContain("new");
  });
});

describe("web page share and import routes", () => {
  test("served page wires #share and #import views without a run action", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('hash === "import"');
    expect(html).toContain("^share=(repo|global):");
    expect(html).toContain("/api/share?");
    expect(html).toContain("/api/import/preview");
    expect(html).toContain("copy import command");
    expect(html).toContain("confirm import");
    expect(html).toContain("replace existing workflows");
    expect(html).toContain("no run");
    expect(html).toContain("confirmLeave()");
    expect(html).toContain('aria-label", "import command"');
    expect(html).toContain('aria-label", "Import workflows"');
    expect(html).toContain("openImport()");
    expect(html).toContain('label: "share"');
    expect(html).toContain("openShare(scope, name)");
    expect(html).toContain('hash === "new"');
    expect(html).toContain("cmd.tabIndex = 0");
    expect(html).toContain("aria-readonly");
    expect(html).not.toMatch(/run imported|import and run|run this bundle/i);
  });

  test("served page clears share/import on empty hash and restores list layout", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const html = await (await fetch(`${base}/?token=${encodeURIComponent(token)}`)).text();
    expect(html).toContain("function syncWorkflowLayout()");
    expect(html).toMatch(/if \(!hash\) \{[\s\S]*?routeView = exitRouteView\(routeView\)/);
    expect(html).toMatch(/if \(!hash\) \{[\s\S]*?confirmLeave\(\)/);
    expect(html).toContain("syncWorkflowLayout()");
    expect(html).toMatch(/openWorkflow[\s\S]*?syncWorkflowLayout\(\)/);
  });

  test("served page restores prior hash when dirty confirm cancels route changes", async () => {
    const root = await repo();
    const { base, token } = await serve(root);
    const html = await (await fetch(`${base}/?token=${encodeURIComponent(token)}`)).text();
    expect(html).toContain("function currentRouteHash()");
    expect(html).toContain("function restoreRouteHash()");
    expect(html).toMatch(/function currentRouteHash\(\) \{/);
    expect(html).toContain('if (tab !== "workflows") return ""');
    expect(html).toContain("#run=");
    expect(html).toMatch(
      /history\.replaceState\(null, "", location\.pathname \+ location\.search \+ want\)/,
    );
    expect(html).toMatch(/if \(!confirmLeave\(\)\) \{\s*restoreRouteHash\(\);\s*return;\s*\}/);
    const cancelRestores = html.match(
      /if \(!confirmLeave\(\)\) \{\s*restoreRouteHash\(\);\s*return;\s*\}/g,
    );
    expect(cancelRestores?.length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(
      /if \(\s*!routeView &&\s*current &&\s*current\.name === name &&\s*current\.scope === scope\s*\)\s*return;/,
    );
    expect(html).toMatch(
      /if \(!confirmLeave\(\)\) \{\s*restoreRouteHash\(\);\s*return;\s*\}\s*tab = "workflows";/,
    );
    expect(html).toContain("routeView = exitRouteView(routeView)");
    expect(html).toContain("configDirty");
    expect(html).toContain("editorDirty");
    expect(html).toContain("discard unsaved config changes?");
    expect(html).toContain("discard unsaved workflow changes?");
    expect(html).toContain("function refreshDirty()");
    expect(html).toContain("unsaved changes");
    expect(html).not.toContain("moved to ");
  });
});

describe("run history web API", () => {
  const dirs: string[] = [];
  let prevState: string | undefined;

  beforeEach(async () => {
    const state = await mkdtemp(join(tmpdir(), "hwf-hist-web-"));
    dirs.push(state);
    prevState = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = state;
  });

  afterEach(async () => {
    if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = prevState;
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function repo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hwf-hist-web-repo-"));
    dirs.push(root);
    await mkdir(join(root, ".hwf", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".hwf", "workflows", "demo.yaml"),
      "version: v1alpha1\nsteps:\n  - run: [printf, hi]\n",
    );
    return root;
  }

  function apiBase(server: { url: string }): string {
    return new URL(server.url).origin;
  }

  test("unauthorized access is forbidden", async () => {
    const root = await repo();
    const server = await startWebServer({ repoRoot: root });
    try {
      const res = await fetch(`${apiBase(server)}/api/runs`);
      expect(res.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("list and detail use no-store and exclude private output", async () => {
    const root = await repo();
    const session = new RunHistorySession();
    await session.claim({
      workflow: "demo",
      source: "repo",
      checkout_root: root,
    });
    await session.recordStep({
      phase: "main",
      workflow: "demo",
      workflow_path: ["demo"],
      ordinal: 1,
      total: 1,
      action: "run",
      label: "boom",
      finished_at: new Date().toISOString(),
      outcome: "failed",
      failure: { action: "run", exit_code: 2 },
      explanation: "secret-stdout-body",
    });
    await session.finalize("failed");
    session.dispose();

    const server = await startWebServer({ repoRoot: root });
    try {
      const list = await fetch(`${apiBase(server)}/api/runs`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(list.headers.get("cache-control")).toBe("no-store");
      const listBody = (await list.json()) as {
        ok: boolean;
        runs: { id: string; failure?: { exit_code?: number } }[];
      };
      expect(listBody.ok).toBe(true);
      expect(JSON.stringify(listBody)).not.toContain("secret-stdout-body");
      expect(listBody.runs[0]?.failure?.exit_code).toBe(2);

      const detail = await fetch(`${apiBase(server)}/api/run?id=${listBody.runs[0]!.id}`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(detail.headers.get("cache-control")).toBe("no-store");
      const detailBody = (await detail.json()) as {
        ok: boolean;
        detail: { failure_explanation?: string; open_workflow?: { name: string } };
      };
      expect(detailBody.detail.failure_explanation).toBe("secret-stdout-body");
      expect(detailBody.detail.open_workflow?.name).toBe("demo");

      const page = await fetch(server.url);
      expect(page.headers.get("cache-control")).toBe("no-store");
    } finally {
      server.stop();
    }
  });

  test("malformed UUID and foreign deep links", async () => {
    const root = await repo();
    const foreign = await mkdtemp(join(tmpdir(), "hwf-foreign-"));
    dirs.push(foreign);
    const session = new RunHistorySession();
    await session.claim({
      workflow: "other",
      source: "global",
      checkout_root: foreign,
    });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();

    const server = await startWebServer({ repoRoot: root });
    try {
      const bad = await fetch(`${apiBase(server)}/api/run?id=550e8400`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(bad.status).toBe(400);
      const body = (await bad.json()) as { detail: { kind: string } };
      expect(body.detail.kind).toBe("invalid");

      const foreignDetail = await fetch(`${apiBase(server)}/api/run?id=${id}`, {
        headers: { "x-hwf-token": server.token },
      });
      const foreignBody = (await foreignDetail.json()) as {
        ok: boolean;
        detail: { checkout_root?: string; open_workflow?: unknown };
      };
      expect(foreignBody.ok).toBe(true);
      expect(foreignBody.detail.checkout_root).toBe(await realpath(foreign));
      expect(foreignBody.detail.open_workflow).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("unsafe storage returns unavailable", async () => {
    const root = await repo();
    const state = process.env.HERDR_PLUGIN_STATE_DIR!;
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "marker"), "x");
    await chmod(state, 0o755);
    const server = await startWebServer({ repoRoot: root });
    try {
      const list = await fetch(`${apiBase(server)}/api/runs`, {
        headers: { "x-hwf-token": server.token },
      });
      expect(list.status).toBe(503);
    } finally {
      server.stop();
    }
  });

  test("prior shared runs.jsonl does not appear in All", async () => {
    const root = await repo();
    const priorPath = join(pluginStateDir(), "runs.jsonl");
    const body = `${JSON.stringify({
      ts: "2020-01-01T00:00:00.000Z",
      run: "abcd1234",
      workflow: "old-log",
      ok: true,
    })}\n`;
    await writeFile(priorPath, body, { mode: 0o600 });
    const server = await startWebServer({ repoRoot: root });
    try {
      const base = apiBase(server);
      const all = await fetch(`${base}/api/runs?location=all`, {
        headers: { "x-hwf-token": server.token },
      });
      const allBody = (await all.json()) as { runs: { workflow: string }[] };
      expect(allBody.runs.every((r) => r.workflow !== "old-log")).toBe(true);
      expect(await Bun.file(priorPath).text()).toBe(body);
    } finally {
      server.stop();
    }
  });

  test("route parsing requires complete UUID", () => {
    const id = allocateRunId();
    const parsed = parseWebRoute(runWorkbenchRoute(id));
    expect(parsed).toEqual({
      kind: "run",
      id,
      hash: `run=${id}`,
    });
    expect(parseWebRoute("run=550e8400")).toBeUndefined();
    const upper = parseWebRoute(`run=${id.toUpperCase()}`);
    expect(upper?.kind === "run" ? upper.id : undefined).toBe(id);
  });

  test("deleted root remains inspectable without open action", async () => {
    const root = await repo();
    const gone = join(tmpdir(), `hwf-gone-${Date.now()}`);
    await mkdir(gone, { recursive: true });
    const canonicalGone = await realpath(gone);
    const session = new RunHistorySession();
    await session.claim({
      workflow: "demo",
      source: "repo",
      checkout_root: gone,
    });
    await session.finalize("succeeded");
    const id = session.id!;
    session.dispose();
    await rm(gone, { recursive: true, force: true });

    const server = await startWebServer({ repoRoot: root });
    try {
      const detail = await fetch(`${apiBase(server)}/api/run?id=${id}`, {
        headers: { "x-hwf-token": server.token },
      });
      const body = (await detail.json()) as {
        ok: boolean;
        detail: { checkout_root?: string; open_workflow?: unknown };
      };
      expect(body.ok).toBe(true);
      expect(body.detail.checkout_root).toBe(canonicalGone);
      expect(body.detail.open_workflow).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});
