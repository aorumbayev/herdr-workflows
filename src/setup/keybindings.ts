import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHerdrConfigPath } from "./paths";

const BINDINGS = [
  {
    marker: "herdr-workflows.launch",
    block: `
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "herdr-workflows.launch"
description = "launch a herdr-workflows workflow (picker)"
`,
  },
];

const DEAD_ACTIONS = new Set([
  "kagan.launch",
  "kagan.results",
  "kagan.reconcile",
  "kagan.confirm",
  "kagan.flag",
  "lembas.launch",
  "lembas.results",
  "lembas.reconcile",
  "lembas.confirm",
  "lembas.flag",
  "herdr-workflows.results",
  "herdr-workflows.reconcile",
  "herdr-workflows.confirm",
  "herdr-workflows.flag",
]);

export type KeybindingInstallResult = {
  messages: string[];
  path: string;
};

function herdrBin(env: NodeJS.ProcessEnv): string {
  return env.HERDR_BIN_PATH?.trim() || "herdr";
}

function spawnHerdr(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { encoding?: "utf8"; stdio?: "ignore" } = {},
) {
  return spawnSync(herdrBin(env), args, {
    ...opts,
    env,
  });
}

function validates(candidate: string, env: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const check = spawnHerdr(
    ["config", "check"],
    {
      ...env,
      HERDR_CONFIG_PATH: candidate,
    },
    { encoding: "utf8" },
  );
  if (check.error) return { ok: false, out: check.error.message };
  const out = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  return { ok: out.includes("config: ok"), out };
}

/** Drop whole `[[keys.command]]` tables whose command is a retired action. */
export function stripDeadBindings(text: string): string {
  const parts = text.split(/(\[\[keys\.command\]\])/);
  if (parts.length === 1) return text;
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i] ?? "";
    const body = parts[i + 1] ?? "";
    const command = body.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1];
    if (command && DEAD_ACTIONS.has(command)) continue;
    out += header + body;
  }
  return out;
}

export function installKeybindings(opts: {
  env?: NodeJS.ProcessEnv;
  reload?: boolean;
}): KeybindingInstallResult {
  const env = opts.env ?? process.env;
  const path = resolveHerdrConfigPath(env);
  const messages: string[] = [];

  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const cleaned = original === null ? null : stripDeadBindings(original);
  const missing = BINDINGS.filter((b) => cleaned === null || !cleaned.includes(b.marker));
  if (missing.length === 0 && cleaned === original) {
    messages.push("herdr-workflows keybindings already present; skipping");
    return { messages, path };
  }

  mkdirSync(dirname(path), { recursive: true });
  const prefix = cleaned && !cleaned.endsWith("\n") ? "\n" : "";
  const next = `${cleaned ?? ""}${prefix}${missing.map((b) => b.block).join("")}`;

  const tmp = `${path}.hwf.tmp`;
  writeFileSync(tmp, next);
  const check = validates(tmp, env);
  if (!check.ok) {
    rmSync(tmp, { force: true });
    messages.push("herdr-workflows keybinding install skipped — herdr config check failed:");
    messages.push(check.out.trim() || "(no output)");
    return { messages, path };
  }

  if (original !== null) writeFileSync(`${path}.hwf.bak`, original);
  renameSync(tmp, path);
  const parts: string[] = [];
  if (missing.length) parts.push(`added ${missing.map((b) => b.marker).join(", ")}`);
  if (cleaned !== original) parts.push("removed dead herdr-workflows.* bindings");
  messages.push(
    `${parts.join("; ")} in ${path}${original !== null ? " (backup: config.toml.hwf.bak)" : ""}`,
  );

  if (opts.reload !== false) {
    const reload = spawnHerdr(["server", "reload-config"], env, { encoding: "utf8" });
    if (reload.error || (reload.status ?? 1) !== 0) {
      const detail =
        reload.error?.message ||
        `${reload.stderr ?? ""}${reload.stdout ?? ""}`.trim() ||
        `exit ${reload.status ?? 1}`;
      messages.push(
        `herdr server reload-config failed (${detail}) — wrote ${path} but the running Herdr may not have loaded the binding yet`,
      );
    } else {
      messages.push(`herdr reloaded config so the running server reads ${path}`);
    }
  }
  return { messages, path };
}
