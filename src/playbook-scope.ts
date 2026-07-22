export type PlaybookSeedScope = "skip" | "global" | "repo";

export function parsePlaybookSeedScope(raw: string): PlaybookSeedScope | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "g" || v === "global") return "global";
  if (v === "r" || v === "repo" || v === "local" || v === "cwd") return "repo";
  if (v === "n" || v === "none" || v === "skip" || v === "no") return "skip";
  return undefined;
}
