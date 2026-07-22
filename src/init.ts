import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoConfigPath } from "./config";
import type { PlaybookSeedScope } from "./playbook-scope";
import { PLAYBOOK_SEED_WORKFLOWS, REPO_SEED_WORKFLOWS, seedWorkflows } from "./seed-workflows";

export type { PlaybookSeedScope } from "./playbook-scope";
export { parsePlaybookSeedScope } from "./playbook-scope";
export { PLAYBOOK_SEED_WORKFLOWS, REPO_SEED_WORKFLOWS, seedWorkflows } from "./seed-workflows";

const KNOWN_AGENTS: { name: string; bin: string; argv: string[] }[] = [
  { name: "claude", bin: "claude", argv: ["claude", "{prompt}"] },
  { name: "codex", bin: "codex", argv: ["codex", "{prompt}"] },
  { name: "aider", bin: "aider", argv: ["aider", "--message", "{prompt}"] },
  { name: "cursor", bin: "cursor", argv: ["cursor", "agent", "{prompt}"] },
];

async function onPath(bin: string): Promise<boolean> {
  const check = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "ignore" });
  return (await check.exited) === 0;
}

export async function detectAgents(): Promise<Record<string, string[]>> {
  const agents: Record<string, string[]> = {};
  for (const agent of KNOWN_AGENTS) {
    if (await onPath(agent.bin)) agents[agent.name] = agent.argv;
  }
  return agents;
}

export function formatAgentsYaml(agents: Record<string, string[]>): string {
  const lines = ["agents:"];
  const names = Object.keys(agents).sort();
  if (names.length === 0) {
    lines.push("  {}");
    return `${lines.join("\n")}\n`;
  }
  for (const name of names) {
    const argv = agents[name]!.map((a) => JSON.stringify(a)).join(", ");
    lines.push(`  ${name}: [${argv}]`);
  }
  return `${lines.join("\n")}\n`;
}

function globalWorkflowsDir(home: string): string {
  return join(home, ".hwf", "workflows");
}

export type InitResult =
  | {
      kind: "wrote";
      path: string;
      agents: string[];
      workflows: string[];
      globalWorkflows: string[];
      playbookScope: PlaybookSeedScope;
    }
  | { kind: "exists"; path: string }
  | {
      kind: "overwritten";
      path: string;
      agents: string[];
      workflows: string[];
      globalWorkflows: string[];
      playbookScope: PlaybookSeedScope;
    };

export async function runInit(
  repoRoot: string,
  opts: {
    force?: boolean;
    confirm?: () => Promise<boolean>;
    /** Where to put handoff/worktree. Default `global` when unset (non-interactive). */
    playbookScope?: PlaybookSeedScope;
    choosePlaybookScope?: () => Promise<PlaybookSeedScope>;
    home?: string;
  } = {},
): Promise<InitResult> {
  const path = repoConfigPath(repoRoot);
  const existed = await Bun.file(path).exists();
  if (existed && !opts.force) {
    if (!opts.confirm) return { kind: "exists", path };
    if (!(await opts.confirm())) return { kind: "exists", path };
  }

  const agents = await detectAgents();
  const home = opts.home ?? process.env.HOME ?? homedir();
  const globalCfg = join(home, ".hwf", "config.yaml");
  const globalDir = globalWorkflowsDir(home);
  const workflowsDir = join(repoRoot, ".hwf", "workflows");

  await mkdir(dirname(path), { recursive: true });
  await mkdir(workflowsDir, { recursive: true });
  await mkdir(dirname(globalCfg), { recursive: true });
  await mkdir(globalDir, { recursive: true });

  await Bun.write(path, formatAgentsYaml(agents));
  if (!(await Bun.file(globalCfg).exists())) {
    await Bun.write(globalCfg, formatAgentsYaml(agents));
  }

  // Detection order, not alphabetical — KNOWN_AGENTS is the preference ranking.
  const first = KNOWN_AGENTS.find((a) => agents[a.name])?.name;
  const playbookScope =
    opts.playbookScope ?? (opts.choosePlaybookScope ? await opts.choosePlaybookScope() : "global");

  let workflows: string[] = [];
  let globalWorkflows: string[] = [];
  if (first) {
    workflows = await seedWorkflows(workflowsDir, first, REPO_SEED_WORKFLOWS);
    if (playbookScope === "repo") {
      workflows = [
        ...workflows,
        ...(await seedWorkflows(workflowsDir, first, PLAYBOOK_SEED_WORKFLOWS)),
      ];
    } else if (playbookScope === "global") {
      globalWorkflows = await seedWorkflows(globalDir, first, PLAYBOOK_SEED_WORKFLOWS);
    }
  }

  const names = Object.keys(agents).sort();
  return existed
    ? { kind: "overwritten", path, agents: names, workflows, globalWorkflows, playbookScope }
    : { kind: "wrote", path, agents: names, workflows, globalWorkflows, playbookScope };
}
