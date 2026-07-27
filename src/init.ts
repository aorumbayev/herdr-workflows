import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  parseConfigText,
  PROFILE_NAME_RE,
  repoConfigPath,
  repoLocalConfigPath,
  type AgentProfile,
  type WorkflowsConfig,
} from "./config";

export const EXAMPLES_URL = "https://aorumbayev.github.io/herdr-workflows/examples";

const KNOWN_KINDS: { name: string; bin: string }[] = [
  { name: "claude", bin: "claude" },
  { name: "codex", bin: "codex" },
  { name: "aider", bin: "aider" },
  { name: "cursor", bin: "cursor" },
];

async function onPath(bin: string): Promise<boolean> {
  const check = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "ignore" });
  return (await check.exited) === 0;
}

export async function detectProfiles(): Promise<Record<string, AgentProfile>> {
  const profiles: Record<string, AgentProfile> = {};
  for (const kind of KNOWN_KINDS) {
    if (!PROFILE_NAME_RE.test(kind.name)) continue;
    if (await onPath(kind.bin)) profiles[kind.name] = { kind: kind.name };
  }
  return profiles;
}

export function formatProfilesYaml(config: {
  profiles: Record<string, AgentProfile>;
  default_profile?: string;
  transcripts?: WorkflowsConfig["transcripts"];
}): string {
  const lines: string[] = ["profiles:"];
  const names = Object.keys(config.profiles).sort();
  if (names.length === 0) {
    lines.push("  {}");
  } else {
    for (const name of names) {
      const profile = config.profiles[name]!;
      lines.push(`  ${name}:`);
      lines.push(`    kind: ${JSON.stringify(profile.kind)}`);
      if (profile.args && profile.args.length > 0) {
        const args = profile.args.map((a) => JSON.stringify(a)).join(", ");
        lines.push(`    args: [${args}]`);
      }
    }
  }
  if (config.default_profile) {
    lines.push(`default_profile: ${JSON.stringify(config.default_profile)}`);
  }
  if (config.transcripts && Object.keys(config.transcripts).length > 0) {
    lines.push("transcripts:");
    for (const kind of Object.keys(config.transcripts).sort()) {
      const command = config.transcripts[kind]!.command.map((a) => JSON.stringify(a)).join(", ");
      lines.push(`  ${kind}:`);
      lines.push(`    command: [${command}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function readPreservedTranscripts(path: string): Promise<WorkflowsConfig["transcripts"]> {
  try {
    if (!(await Bun.file(path).exists())) return {};
    return parseConfigText(path, await Bun.file(path).text()).transcripts;
  } catch {
    return {};
  }
}

async function ensureLocalConfigGitignored(repoRoot: string): Promise<void> {
  const hwfDir = dirname(repoConfigPath(repoRoot));
  const ignorePath = join(hwfDir, ".gitignore");
  const marker = basename(repoLocalConfigPath(repoRoot));
  if (await Bun.file(ignorePath).exists()) {
    const text = await Bun.file(ignorePath).text();
    if (text.split(/\r?\n/).some((line) => line.trim() === marker)) return;
    const next = text.endsWith("\n") ? `${text}${marker}\n` : `${text}\n${marker}\n`;
    await Bun.write(ignorePath, next);
    return;
  }
  await Bun.write(ignorePath, `${marker}\n`);
}

export type InitResult =
  | { kind: "wrote"; path: string; profiles: string[] }
  | { kind: "exists"; path: string }
  | { kind: "overwritten"; path: string; profiles: string[] };

export async function runInit(
  repoRoot: string,
  opts: {
    force?: boolean;
    confirm?: () => Promise<boolean>;
  } = {},
): Promise<InitResult> {
  const path = repoConfigPath(repoRoot);
  const existed = await Bun.file(path).exists();
  if (existed && !opts.force) {
    if (!opts.confirm) return { kind: "exists", path };
    if (!(await opts.confirm())) return { kind: "exists", path };
  }

  const profiles = await detectProfiles();
  const names = Object.keys(profiles).sort();
  const hwfDir = dirname(path);
  const workflowsDir = join(repoRoot, ".hwf", "workflows");

  await mkdir(hwfDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });
  await ensureLocalConfigGitignored(repoRoot);

  const transcripts = existed ? await readPreservedTranscripts(path) : {};
  await Bun.write(
    path,
    formatProfilesYaml({
      profiles,
      ...(names[0] !== undefined ? { default_profile: names[0] } : {}),
      transcripts,
    }),
  );

  return existed
    ? { kind: "overwritten", path, profiles: names }
    : { kind: "wrote", path, profiles: names };
}
