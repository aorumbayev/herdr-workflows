import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type AgentsConfig = Record<string, string[]>;
export type SessionsConfig = Record<string, string[]>;

export type WorkflowsConfig = {
  agents: AgentsConfig;
  sessions: SessionsConfig;
};

class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

const configSchema = z
  .object({
    agents: z.record(z.string(), z.array(z.string()).min(1)),
    sessions: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [name, argv] of Object.entries(cfg.agents)) {
      const slots = argv.filter((a) => a === "{prompt}");
      if (slots.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `agent '${name}' must contain exactly one "{prompt}" argv element`,
          path: ["agents", name],
        });
      }
    }
  });

function positioned(file: string, key: string | undefined, message: string): string {
  return key ? `${file}, ${key}: ${message}` : `${file}: ${message}`;
}

function formatIssue(file: string, issue: z.core.$ZodIssue): string {
  const path = issue.path;
  let key: string | undefined;
  if (path.length > 0) key = path.map(String).join(".");
  else if (issue.code === "unrecognized_keys") key = (issue as { keys: string[] }).keys.join(", ");
  return positioned(file, key, issue.message);
}

async function loadFile(file: string): Promise<WorkflowsConfig | undefined> {
  const f = Bun.file(file);
  if (!(await f.exists())) return undefined;
  let data: unknown;
  try {
    data = Bun.YAML.parse(await f.text());
  } catch (error) {
    throw new ConfigLoadError(
      positioned(file, undefined, error instanceof Error ? error.message : String(error)),
    );
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigLoadError(result.error.issues.map((i) => formatIssue(file, i)).join("; "));
  }
  return {
    agents: result.data.agents,
    sessions: result.data.sessions ?? {},
  };
}

export function globalConfigPath(): string {
  return join(process.env.HOME ?? homedir(), ".hwf", "config.yaml");
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, ".hwf", "config.yaml");
}

/** Merge global then repo; repo wins per name for agents and sessions independently. */
export async function loadConfig(repoRoot: string): Promise<WorkflowsConfig> {
  const globalCfg = (await loadFile(globalConfigPath())) ?? { agents: {}, sessions: {} };
  const repoCfg = (await loadFile(repoConfigPath(repoRoot))) ?? { agents: {}, sessions: {} };
  return {
    agents: { ...globalCfg.agents, ...repoCfg.agents },
    sessions: { ...globalCfg.sessions, ...repoCfg.sessions },
  };
}

export function fillAgentArgv(template: string[], prompt: string): string[] {
  return template.map((part) => (part === "{prompt}" ? prompt : part));
}
