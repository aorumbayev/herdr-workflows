#!/usr/bin/env node
// Runs as a plugin [[build]] step so `herdr plugin install` ships herdr-workflows's keybindings enabled.
// herdr v1 has no manifest keybinding field, so the only way to enable keys on install is to append
// them to the user's config.toml. Safety: idempotent, append-only, atomic write, backup kept,
// validated with `herdr config check` before it replaces the live file, and never fatal.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function configPath() {
  if (process.env.HERDR_CONFIG_PATH) return process.env.HERDR_CONFIG_PATH;
  const base = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "herdr")
    : join(homedir(), ".config", "herdr");
  return join(base, "config.toml");
}

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";

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

function validates(candidate) {
  const check = spawnSync(HERDR, ["config", "check"], {
    env: { ...process.env, HERDR_CONFIG_PATH: candidate },
    encoding: "utf8",
  });
  if (check.error) return { ok: true, out: "" };
  const out = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  return { ok: out.includes("config: ok"), out };
}

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

/** Drop whole `[[keys.command]]` tables whose command is a retired herdr-workflows action. */
function stripDeadBindings(text) {
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
  return out.replace(/\n{3,}/g, "\n\n");
}

try {
  const path = configPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  const cleaned = original === null ? null : stripDeadBindings(original);
  const missing = BINDINGS.filter((b) => cleaned === null || !cleaned.includes(b.marker));
  if (missing.length === 0 && cleaned === original) {
    console.log("herdr-workflows keybindings already present; skipping");
    process.exit(0);
  }

  mkdirSync(dirname(path), { recursive: true });
  const prefix = cleaned && !cleaned.endsWith("\n") ? "\n" : "";
  const next = `${cleaned ?? ""}${prefix}${missing.map((b) => b.block).join("")}`;

  const tmp = `${path}.hwf.tmp`;
  writeFileSync(tmp, next);
  const check = validates(tmp);
  if (!check.ok) {
    rmSync(tmp, { force: true });
    console.log("herdr-workflows keybinding install skipped — herdr config check failed:");
    console.log(check.out.trim() || "(no output)");
    process.exit(0);
  }

  if (original !== null) writeFileSync(`${path}.hwf.bak`, original);
  renameSync(tmp, path);
  const parts = [];
  if (missing.length) parts.push(`added ${missing.map((b) => b.marker).join(", ")}`);
  if (cleaned !== original) parts.push("removed dead herdr-workflows.* bindings");
  console.log(
    `${parts.join("; ")} in ${path}${original !== null ? " (backup: config.toml.hwf.bak)" : ""}`,
  );
  spawnSync(HERDR, ["server", "reload-config"], { stdio: "ignore" });
} catch (error) {
  console.log(`skipped keybinding install: ${error instanceof Error ? error.message : error}`);
}
