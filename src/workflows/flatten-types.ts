import type { FlatStep } from "./types";
import type { RawWorkflow } from "./parse";

export type FlattenFn = (
  name: string,
  repoRoot: string,
  stack: string[],
  agents: Set<string>,
  parentBound: Set<string>,
  sources?: Set<"repo" | "global">,
  root?: { file: string; source: "repo" | "global" },
  rootRaw?: RawWorkflow,
) => Promise<FlatStep[]>;
