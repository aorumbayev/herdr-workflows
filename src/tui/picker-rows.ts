import type { SelectOption } from "@opentui/core";
import { sensitivityLabels, workflowDisplayTitle } from "../workflow/trust";
import type { WorkflowListEntry } from "../workflow/types";

const ELLIPSIS = "...";
export const CHROME_SEP = " | ";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// SelectRenderable draws name at contentX+1+indicatorWidth; indicator off → pad 1 only.
const SELECT_NAME_OFFSET = 1;
const CURSOR_PREFIX_WIDTH = 2;
const ROW_TEXT_INDENT = SELECT_NAME_OFFSET + CURSOR_PREFIX_WIDTH;
const LOCATION_WIDTH = 7;
const WARNING_WIDTH = 2;

type PickerRowValue = { entry: WorkflowListEntry };

function columns(text: string): number {
  return Bun.stringWidth(text);
}

function padColumns(text: string, width: number): string {
  const used = columns(text);
  if (used >= width) return text;
  return `${text}${" ".repeat(width - used)}`;
}

function takeColumns(text: string, max: number): string {
  if (max <= 0) return "";
  if (columns(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = columns(segment);
    if (used + w > max) break;
    out += segment;
    used += w;
  }
  return out;
}

/** Truncate to `max` terminal columns at a grapheme boundary. */
export function truncate(text: string, max: number): string {
  if (columns(text) <= max) return text;
  if (max <= 0) return "";
  const ellipsisCols = columns(ELLIPSIS);
  if (max < ellipsisCols) return takeColumns(ELLIPSIS, max);
  return `${takeColumns(text, max - ellipsisCols)}${ELLIPSIS}`;
}

export function stripFilePrefix(error: string, file: string): string {
  return error.startsWith(file) ? error.slice(file.length).replace(/^[,:]\s*/, "") : error;
}

export function entrySensitivity(entry: WorkflowListEntry): string[] {
  return sensitivityLabels({
    hasCommands: entry.hasCommands === true,
    hasTranscript: entry.needsTranscript === true,
    sensitiveMethods: entry.sensitiveMethods ?? [],
    unresolvedChildren: entry.unresolvedChildren ?? [],
  });
}

export function formatPickerRowName(
  title: string,
  location: "global" | "repo" | "invalid",
  warned: boolean,
  rowWidth: number,
  selected = false,
): string {
  const titleW = Math.max(
    0,
    rowWidth - SELECT_NAME_OFFSET - CURSOR_PREFIX_WIDTH - 1 - WARNING_WIDTH - LOCATION_WIDTH,
  );
  const prefix = selected ? "> " : "  ";
  const warning = warned ? "! " : "  ";
  return `${prefix}${padColumns(truncate(title, titleW), titleW)} ${warning}${location.padStart(LOCATION_WIDTH)}`;
}

export function buildPickerOptions(valid: WorkflowListEntry[], rowWidth: number): SelectOption[] {
  return valid.map((entry) => ({
    name: formatPickerRowName(
      workflowDisplayTitle(entry.name, entry.title),
      entry.source === "repo" ? "repo" : "global",
      entrySensitivity(entry).length > 0,
      rowWidth,
    ),
    description: entry.description?.trim() || entry.name,
    value: { entry } satisfies PickerRowValue,
  }));
}

export function buildInvalidOptions(
  invalid: WorkflowListEntry[],
  rowWidth: number,
): SelectOption[] {
  return invalid.map((entry) => ({
    name: formatPickerRowName(
      workflowDisplayTitle(entry.name, entry.title),
      "invalid",
      entrySensitivity(entry).length > 0,
      rowWidth,
    ),
    description: stripFilePrefix(entry.error ?? "", entry.file),
    value: { entry } satisfies PickerRowValue,
  }));
}

export function formatRunProgress(
  name: string,
  lines: string[],
  terminal?: { ok: boolean; detail: string },
): string {
  const body = lines.length > 0 ? lines.join("\n") : ELLIPSIS;
  if (!terminal) return `${name}\n${body}`;
  const status = terminal.ok ? "Done." : `Failed${CHROME_SEP}${terminal.detail}`;
  return `${name}\n${body}\n\n${status}`;
}

export function filterChoiceOptions(options: string[], filter: string): string[] {
  return filter ? options.filter((option) => option.includes(filter)) : options;
}

export function formatRule(contentWidth: number): string {
  const field = Math.max(0, contentWidth - ROW_TEXT_INDENT);
  return `${" ".repeat(ROW_TEXT_INDENT)}${"-".repeat(field)}`;
}

export function formatListFooter(
  contentWidth: number,
  selectedIndex: number,
  total: number,
  hint: string,
): string {
  if (total === 0) return truncate(hint, contentWidth);
  const counter = `${selectedIndex + 1}/${total}`;
  const hintCols = columns(hint);
  const counterCols = columns(counter);
  if (hintCols + 1 + counterCols <= contentWidth) {
    const pad = contentWidth - hintCols - counterCols;
    return `${hint}${" ".repeat(pad)}${counter}`;
  }
  const clipped = truncate(hint, Math.max(0, contentWidth - counterCols - 1));
  const pad = Math.max(0, contentWidth - columns(clipped) - counterCols);
  return `${clipped}${" ".repeat(pad)}${counter}`;
}

function takeWrappedLine(text: string, budget: number): string {
  if (columns(text) <= budget) return text;
  const window = takeColumns(text, budget);
  const space = window.lastIndexOf(" ");
  if (space > 0) return window.slice(0, space);
  return window;
}

export function formatDetailLines(description: string, contentWidth: number): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const indent = " ".repeat(ROW_TEXT_INDENT);
  const budget = Math.max(0, contentWidth - ROW_TEXT_INDENT);
  const line1 = takeWrappedLine(text, budget);
  const rest = text.slice(line1.length).trimStart();
  if (!rest) return `${indent}${line1}`;
  const line2 = columns(rest) <= budget ? rest : truncate(rest, budget);
  return `${indent}${line1}\n${indent}${line2}`;
}
