import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SelectOption } from "@opentui/core";
import { globalConfigPath, repoConfigPath } from "../config";
import type { WorkflowListEntry } from "../workflows";
import type { RunLogEntry } from "../runlog";
import { stripFilePrefix, truncate } from "./text";

const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

export type ManageTab = "workflows" | "config" | "runs";

export const MANAGE_TABS: { name: string; value: ManageTab }[] = [
  { name: "Workflows", value: "workflows" },
  { name: "Config", value: "config" },
  { name: "Runs", value: "runs" },
];

export type ManageRowValue =
  | { kind: "workflow"; file: string; name: string }
  | { kind: "config"; scope: "repo" | "global"; file: string; missing: boolean }
  | { kind: "run"; run: string; workflow: string; ok: boolean; error?: string; ts: string };

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_RE.test(name);
}

function filterByName<T extends { name: string }>(items: T[], filter: string): T[] {
  if (!filter) return items;
  return items.filter((i) => i.name.includes(filter));
}

export function buildWorkflowOptions(workflows: WorkflowListEntry[], filter = ""): SelectOption[] {
  return filterByName(workflows, filter).map((m) => ({
    name: m.name,
    description: m.error
      ? `${m.source} · invalid: ${truncate(stripFilePrefix(m.error, m.file), 44)}`
      : `${m.source} · ${basename(m.file)}`,
    value: { kind: "workflow", file: m.file, name: m.name } satisfies ManageRowValue,
  }));
}

export function buildConfigOptions(
  repoConfigExists: boolean,
  globalConfigExists: boolean,
  repoRoot: string,
): SelectOption[] {
  return [
    {
      name: "config (repo)",
      description: repoConfigExists ? ".hwf/config.yaml" : ".hwf/config.yaml · missing",
      value: {
        kind: "config",
        scope: "repo",
        file: repoConfigPath(repoRoot),
        missing: !repoConfigExists,
      } satisfies ManageRowValue,
    },
    {
      name: "config (global)",
      description: globalConfigExists ? "~/.hwf/config.yaml" : "~/.hwf/config.yaml · missing",
      value: {
        kind: "config",
        scope: "global",
        file: globalConfigPath(),
        missing: !globalConfigExists,
      } satisfies ManageRowValue,
    },
  ];
}

export function buildRunOptions(runs: RunLogEntry[], filter = ""): SelectOption[] {
  const matched = filter ? runs.filter((r) => r.workflow.includes(filter)) : runs;
  return matched.map((r) => ({
    name: `${r.workflow}  ${r.run}`,
    description: `${r.ok ? "ok" : "fail"} · ${r.ts}`,
    value: {
      kind: "run",
      run: r.run,
      workflow: r.workflow,
      ok: r.ok,
      error: r.error,
      ts: r.ts,
    } satisfies ManageRowValue,
  }));
}

export function workflowFilePath(scope: "repo" | "global", repoRoot: string, name: string): string {
  const dir =
    scope === "repo" ? join(repoRoot, ".hwf", "workflows") : join(homedir(), ".hwf", "workflows");
  return join(dir, `${name}.yaml`);
}

export function formatRunPreview(
  entries: RunLogEntry[],
  runId: string,
  fallback: ManageRowValue & { kind: "run" },
): string {
  const steps = entries.filter((e) => e.run === runId && e.step !== undefined);
  if (steps.length === 0) {
    return fallback.ok ? "ok" : (fallback.error ?? "fail");
  }
  return steps
    .map((s) => {
      const head = `${s.ok ? "ok" : "fail"} ${s.step}/${s.total} ${s.label ?? ""}`.trim();
      return s.error ? `${head}: ${truncate(s.error, 60)}` : head;
    })
    .join("\n");
}

export function previewLines(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}
