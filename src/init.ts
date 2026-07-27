import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfigText, repoConfigPath, type SessionsConfig } from "./config";

export const EXAMPLES_URL = "https://aorumbayev.github.io/herdr-workflows/examples";

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
  | { kind: "wrote"; path: string; agents: string[] }
  | { kind: "exists"; path: string }
  | { kind: "overwritten"; path: string; agents: string[] };

export async function runInit(
  repoRoot: string,
  opts: {
    force?: boolean;
    confirm?: () => Promise<boolean>;
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

  const names = Object.keys(agents).sort();
  return existed
    ? { kind: "overwritten", path, agents: names }
    : { kind: "wrote", path, agents: names };
}
