import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureLocalConfigGitignored,
  globalConfigPath,
  parseConfigText,
  PROFILE_NAME_RE,
  repoConfigPath,
  type AgentProfile,
  type WorkflowsConfig,
} from "./context";

/** Kinds `herdr agent start --kind` accepts (herdr 0.7.5 cli-reference). Native start stays authoritative. */
const HERDR_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "maki",
] as const;

/** Probe subset: kinds above whose canonical executable name is known. */
const KNOWN_KINDS: { name: (typeof HERDR_AGENT_KINDS)[number]; bin: string }[] = [
  { name: "claude", bin: "claude" },
  { name: "codex", bin: "codex" },
  { name: "cursor", bin: "cursor" },
  { name: "opencode", bin: "opencode" },
];

async function onPath(bin: string): Promise<boolean> {
  return Bun.which(bin) !== null;
}

async function detectProfiles(): Promise<Record<string, AgentProfile>> {
  const profiles: Record<string, AgentProfile> = {};
  for (const kind of KNOWN_KINDS) {
    if (!PROFILE_NAME_RE.test(kind.name)) continue;
    if (await onPath(kind.bin)) profiles[kind.name] = { kind: kind.name };
  }
  return profiles;
}

function formatProfilesYaml(config: {
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

type InitResult =
  | { kind: "wrote"; path: string; profiles: string[] }
  | { kind: "exists"; path: string }
  | { kind: "overwritten"; path: string; profiles: string[] };

export async function runInit(
  repoRoot: string,
  opts: {
    force?: boolean;
    confirm?: () => Promise<boolean>;
    global?: boolean;
  } = {},
): Promise<InitResult> {
  const path = opts.global ? await globalConfigPath() : repoConfigPath(repoRoot);
  const existed = await Bun.file(path).exists();
  if (existed && !opts.force) {
    if (!opts.confirm) return { kind: "exists", path };
    if (!(await opts.confirm())) return { kind: "exists", path };
  }

  const profiles = await detectProfiles();
  const names = Object.keys(profiles).sort();

  await mkdir(dirname(path), { recursive: true });
  if (!opts.global) {
    await mkdir(join(repoRoot, ".hwf", "workflows"), { recursive: true });
    await ensureLocalConfigGitignored(repoRoot);
  }

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

/** Declared internal seam — unit tests pin detect/format without widening the CLI export surface. */
export const initSeams = {
  HERDR_AGENT_KINDS,
  detectProfiles,
  formatProfilesYaml,
};
