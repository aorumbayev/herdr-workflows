#!/usr/bin/env bun
/**
 * Objective oracle: load YAML through hwf's real loader.
 * usage: bun oracle.ts <file.yaml|-> [name]        -> {"ok":true} / {"ok":false,"error":…}
 *        bun oracle.ts --dir <dir>                  -> one JSON line per *.yaml
 * Env: HWF_REPO (default: the herdr-workflows checkout next to this script's config).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// This script lives at <repo>/.agents/skills/promptfoo-skill-eval/scripts/, so the checkout is
// four levels up — no absolute path to go stale when the repo moves or is cloned elsewhere.
const REPO = process.env.HWF_REPO ?? resolve(import.meta.dir, "..", "..", "..", "..");
const { loadWorkflow } = (await import(join(REPO, "src/workflow/inputs-exchange-exchange.ts"))) as {
  loadWorkflow: (name: string, root: string, config: unknown) => Promise<{ steps: unknown[] }>;
};

const config = {
  profiles: { claude: { kind: "claude" }, codex: { kind: "codex" } },
  default_profile: "claude",
  transcripts: {},
};

type Case = { name: string; text: string; label: string };

/** Sibling workflows to place alongside the cases, so `workflow: <child>` refs resolve. */
const seedDir = (() => {
  const i = process.argv.indexOf("--seed");
  return i > -1 ? process.argv[i + 1] : undefined;
})();

async function check(cases: Case[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hwf-oracle-"));
  const dest = join(root, ".hwf", "workflows");
  await mkdir(dest, { recursive: true });
  if (seedDir) {
    for (const f of (await readdir(seedDir).catch(() => [])) as string[]) {
      if (f.endsWith(".yaml"))
        await writeFile(join(dest, f), await readFile(join(seedDir, f), "utf8"));
    }
  }
  await Promise.all(cases.map((c) => writeFile(join(dest, `${c.name}.yaml`), c.text)));
  for (const c of cases) {
    try {
      const wf = await loadWorkflow(c.name, root, config);
      console.log(JSON.stringify({ label: c.label, ok: wf.steps.length > 0 }));
    } catch (err) {
      console.log(
        JSON.stringify({
          label: c.label,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  await rm(root, { recursive: true, force: true });
}

const args = process.argv.slice(2);
if (args[0] === "--dir") {
  const dir = args[1]!;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  await check(
    await Promise.all(
      files.map(async (f) => {
        const name = basename(f, ".yaml");
        return { name, label: name, text: await readFile(join(dir, f), "utf8") };
      }),
    ),
  );
} else {
  const file = args[0]!;
  const text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
  const name = args[1] ?? basename(file, ".yaml").replace(/[^a-z0-9_-]/g, "-");
  await check([{ name, label: name, text }]);
}
