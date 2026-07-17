import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoConfigPath } from "./config";

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

const SEED_WORKFLOWS: { name: string; body: (agent: string) => string }[] = [
  {
    name: "handoff",
    body: (agent) => `steps:
  - agent: ${agent}
    prompt: |
      Continue from this pane context:

      {pane}

      Focus: {prompt}
`,
  },
  {
    name: "review",
    body: (agent) => `steps:
  - shell: git diff HEAD
  - agent: ${agent}
    prompt: |
      Review this diff. List blocking issues only.

      {last}
    wait: done
    timeout: 900
`,
  },
];

/** Writes example workflows for the given agent; never overwrites existing files. */
export async function seedWorkflows(workflowsDir: string, agent: string): Promise<string[]> {
  const written: string[] = [];
  for (const seed of SEED_WORKFLOWS) {
    const file = join(workflowsDir, `${seed.name}.yaml`);
    if (await Bun.file(file).exists()) continue;
    await Bun.write(file, seed.body(agent));
    written.push(seed.name);
  }
  return written;
}

export type InitResult =
  | { kind: "wrote"; path: string; agents: string[]; workflows: string[] }
  | { kind: "exists"; path: string }
  | { kind: "overwritten"; path: string; agents: string[]; workflows: string[] };

export async function runInit(
  repoRoot: string,
  opts: { force?: boolean; confirm?: () => Promise<boolean> } = {},
): Promise<InitResult> {
  const path = repoConfigPath(repoRoot);
  const existed = await Bun.file(path).exists();
  if (existed && !opts.force) {
    if (!opts.confirm) return { kind: "exists", path };
    if (!(await opts.confirm())) return { kind: "exists", path };
  }

  const agents = await detectAgents();
  const workflowsDir = join(repoRoot, ".hwf", "workflows");
  await mkdir(dirname(path), { recursive: true });
  await mkdir(workflowsDir, { recursive: true });
  await Bun.write(path, formatAgentsYaml(agents));
  // Detection order, not alphabetical — KNOWN_AGENTS is the preference ranking.
  const first = KNOWN_AGENTS.find((a) => agents[a.name])?.name;
  const workflows = first ? await seedWorkflows(workflowsDir, first) : [];
  const names = Object.keys(agents).sort();
  return existed
    ? { kind: "overwritten", path, agents: names, workflows }
    : { kind: "wrote", path, agents: names, workflows };
}
