import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfigText, repoConfigPath, type SessionsConfig } from "./config";

export type PlaybookSeedScope = "skip" | "global" | "repo";

export function parsePlaybookSeedScope(raw: string): PlaybookSeedScope | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "g" || v === "global") return "global";
  if (v === "r" || v === "repo" || v === "local" || v === "cwd") return "repo";
  if (v === "n" || v === "none" || v === "skip" || v === "no") return "skip";
  return undefined;
}

export type Seed = { name: string; body: (agent: string) => string };

/** Shared playbooks (handoff, worktree). Distill uses invoking agent. */
export const PLAYBOOK_SEED_WORKFLOWS: Seed[] = [
  {
    name: "handoff",
    body: () => `inputs:
  target: agents
  focus: text = ""
steps:
  - agent: "{agent}"
    timeout: 900
    out: brief
    prompt: |
      Below the --- marker is a coding agent session transcript. Distil it into
      a handoff prompt for a fresh agent session.

      Keep (signal):
      - architectural decisions with their rationale
      - working solutions adopted (final approach, not the journey)
      - configuration choices: versions, settings, flags, env vars
      - files created/modified with paths and why
      - constraints discovered: API limits, compatibility issues, platform quirks
      - productive dead ends, one sentence each: what was tried, why it failed,
        what it means for remaining work
      - open questions and unresolved trade-offs
      - anything the next session would otherwise re-discover

      Drop (noise):
      - corrections and retries: keep only the final correct version
      - verbose tool output: summarise builds, tests, diffs
      - permission prompts and settled back-and-forth
      - repeated attempts: describe the working one once

      Compression: error-fix cycles reduce to root cause + fix; explorations
      collapse to their conclusion; long discussions reduce to the decision and
      key reason.

      Output ONLY the handoff prompt, second-person imperative, in this shape
      (omit empty sections):

      Continue the work from the previous session. Here is the context you need:

      **Project**: <path>
      **Branch**: <branch, if known>

      ## Background
      ## What was done
      ## Decisions in effect
      ## Current state
      ## Open questions
      ## Your next steps
      1. <directive>

      Never invent decisions or context not present in the transcript; note
      unclear items as open questions.

      ---
      {session}
  - agent: "{target}"
    prompt: |
      Focus: {focus}

      {brief}
  - tab.close: { tab_id: "{source_tab}" }
`,
  },
  {
    name: "worktree",
    body: () => `inputs:
  branch: text
  base: [main, develop] = main
steps:
  - worktree.create: { branch: "{branch}", base: "{base}", label: "{branch}", focus: true }
    out: { path: worktree.path }
`,
  },
];

/** Always seeded into the repo on init (when an agent is detected). */
export const REPO_SEED_WORKFLOWS: Seed[] = [
  {
    name: "review",
    body: (agent) => `steps:
  - run: git diff HEAD
    out: diff
  - agent: ${JSON.stringify(agent)}
    when: "{diff}"
    timeout: 900
    prompt: |
      Review this diff. List blocking issues only.

      {diff}
`,
  },
];

/** Writes seeds into workflowsDir; never overwrites existing files. */
export async function seedWorkflows(
  workflowsDir: string,
  agent: string,
  seeds: Seed[],
): Promise<string[]> {
  const written: string[] = [];
  await mkdir(workflowsDir, { recursive: true });
  for (const seed of seeds) {
    const file = join(workflowsDir, `${seed.name}.yaml`);
    if (await Bun.file(file).exists()) continue;
    await Bun.write(file, seed.body(agent));
    written.push(seed.name);
  }
  return written;
}

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

function formatArgvMap(key: string, entries: Record<string, string[]>): string[] {
  const lines = [`${key}:`];
  const names = Object.keys(entries).sort();
  if (names.length === 0) {
    lines.push("  {}");
    return lines;
  }
  for (const name of names) {
    const argv = entries[name]!.map((a) => JSON.stringify(a)).join(", ");
    lines.push(`  ${name}: [${argv}]`);
  }
  return lines;
}

export function formatAgentsYaml(
  agents: Record<string, string[]>,
  sessions: SessionsConfig = {},
): string {
  const lines = formatArgvMap("agents", agents);
  if (Object.keys(sessions).length > 0) {
    lines.push(...formatArgvMap("sessions", sessions));
  }
  return `${lines.join("\n")}\n`;
}

async function readSessions(path: string): Promise<SessionsConfig> {
  try {
    if (!(await Bun.file(path).exists())) return {};
    return parseConfigText(path, await Bun.file(path).text()).sessions;
  } catch {
    return {};
  }
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

  const sessions = await readSessions(path);
  await Bun.write(path, formatAgentsYaml(agents, sessions));
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
