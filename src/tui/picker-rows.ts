import type { SelectOption } from "@opentui/core";
import type { WorkflowListEntry } from "../workflows";
import { stripFilePrefix, truncate } from "./text";

export type PickerRowValue = { entry: WorkflowListEntry };

export function filterWorkflowEntries(
  entries: WorkflowListEntry[],
  filter: string,
): { valid: WorkflowListEntry[]; invalid: WorkflowListEntry[] } {
  const matched = filter ? entries.filter((e) => e.name.includes(filter)) : entries;
  return {
    valid: matched.filter((e) => !e.error),
    invalid: matched.filter((e) => e.error),
  };
}

export function buildPickerOptions(valid: WorkflowListEntry[]): SelectOption[] {
  return valid.map((entry) => {
    const parts = [entry.name, entry.source];
    if (entry.inputs?.length) parts.push("inputs");
    if (entry.needsPrompt) parts.push("prompt");
    return {
      name: parts.join(" · "),
      description: "",
      value: { entry } satisfies PickerRowValue,
    };
  });
}

export function formatInvalidLines(invalid: WorkflowListEntry[]): string {
  if (invalid.length === 0) return "";
  return invalid
    .map((e) => `${e.name} — invalid: ${truncate(stripFilePrefix(e.error ?? "", e.file), 44)}`)
    .join("\n");
}

export function formatRunProgress(
  name: string,
  lines: string[],
  terminal?: { ok: boolean; detail: string },
): string {
  const body = lines.length > 0 ? lines.join("\n") : "…";
  if (!terminal) return `${name}\n${body}`;
  const status = terminal.ok ? "Done." : `Failed · ${terminal.detail}`;
  return `${name}\n${body}\n\n${status}`;
}

export function filterChoiceOptions(options: string[], filter: string): string[] {
  return filter ? options.filter((option) => option.includes(filter)) : options;
}
