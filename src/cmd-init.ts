import { die } from "./adapter/popup";
import { readLine } from "./adapter/stdin";
import { parseArgs } from "./cli-args";
import { runInit } from "./init";
import { parsePlaybookSeedScope } from "./playbook-scope";
import { resolveRepoRoot } from "./repo";

export async function cmdInit(args: string[]): Promise<void> {
  const { bools, flags } = parseArgs(args);
  const repoRoot = await resolveRepoRoot();
  const seedFlag = flags.seed ?? flags["seed-playbooks"];
  const playbookScope = seedFlag ? parsePlaybookSeedScope(seedFlag) : undefined;
  if (seedFlag && !playbookScope) {
    die("usage: hwf init [--force] [--seed=global|repo|none]");
  }
  const result = await runInit(repoRoot, {
    force: bools.has("force") || bools.has("yes"),
    playbookScope,
    confirm: async () => {
      if (!process.stdin.isTTY) return false;
      process.stdout.write(`.hwf/config.yaml exists — overwrite? [y/N] `);
      const line = await readLine();
      return line.kind === "line" && line.text.trim().toLowerCase() === "y";
    },
    choosePlaybookScope:
      playbookScope || !process.stdin.isTTY
        ? undefined
        : async () => {
            process.stdout.write(
              "Seed handoff + worktree? [g]lobal ~/.hwf / [r]epo .hwf / [n]one [G]: ",
            );
            const line = await readLine();
            if (line.kind !== "line") return "global";
            const parsed = parsePlaybookSeedScope(line.text || "g");
            return parsed ?? "global";
          },
  });
  if (result.kind === "exists") die(`${result.path} already exists (pass --force to overwrite)`);
  const agents = result.agents.length ? ` (${result.agents.join(", ")})` : " (no agents on PATH)";
  const workflows = result.workflows.length
    ? `seeded repo workflows: ${result.workflows.join(", ")}\n`
    : "";
  const global = result.globalWorkflows.length
    ? `seeded global workflows (~/.hwf): ${result.globalWorkflows.join(", ")}\n`
    : "";
  const skipped =
    result.playbookScope === "skip" && !result.globalWorkflows.length
      ? "skipped handoff/worktree seeds\n"
      : "";
  process.stdout.write(`wrote ${result.path}${agents}\n${workflows}${global}${skipped}`);
}
