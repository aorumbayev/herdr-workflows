import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Seed = { name: string; body: (agent: string) => string };

/** Shared playbooks (handoff, worktree). Distill uses invoking agent. */
export const PLAYBOOK_SEED_WORKFLOWS: Seed[] = [
  {
    name: "handoff",
    body: () => `inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: cat
    stdin: "{session}"
  - agent: "{agent}"
    prompt: |
      Below the --- marker is a coding agent session transcript. Distil it into
      a handoff prompt for a fresh agent session.

      Keep (signal):
      - architectural decisions with their rationale
      - working solutions adopted (final approach, not the journey)
      - configuration choices: versions, settings, flags, env vars
      - files created/modified with paths and why
      - constraints discovered: API limits, compatibility issues, platform quirks
      - productive dead ends, one sentence each: what was tried, why it failed,
        what it means for remaining work
      - open questions and unresolved trade-offs
      - anything the next session would otherwise re-discover

      Drop (noise):
      - corrections and retries: keep only the final correct version
      - verbose tool output: summarise builds, tests, diffs
      - permission prompts and settled back-and-forth
      - repeated attempts: describe the working one once

      Compression: error-fix cycles reduce to root cause + fix; explorations
      collapse to their conclusion; long discussions reduce to the decision and
      key reason.

      Output ONLY the handoff prompt, second-person imperative, in this shape
      (omit empty sections):

      Continue the work from the previous session. Here is the context you need:

      **Project**: <path>
      **Branch**: <branch, if known>

      ## Background
      ## What was done
      ## Decisions in effect
      ## Current state
      ## Open questions
      ## Your next steps
      1. <directive>

      Never invent decisions or context not present in the transcript; note
      unclear items as open questions.

      ---
      {last}
    wait: done
    timeout: 900
  - agent: "{input.target}"
    prompt: |
      Focus: {input.focus}

      {last}
    close_source: true
`,
  },
  {
    name: "worktree",
    body: () => `inputs:
  branch:
    label: new branch name
  base:
    options: [main, develop]
    default: main
steps:
  - shell: herdr worktree create --branch "$HWF_INPUT_branch" --base "$HWF_INPUT_base" --label "$HWF_INPUT_branch" --focus
`,
  },
];

/** Always seeded into the repo on init (when an agent is detected). */
export const REPO_SEED_WORKFLOWS: Seed[] = [
  {
    name: "review",
    body: (agent) => `steps:
  - shell: git diff HEAD
  - agent: ${JSON.stringify(agent)}
    prompt: |
      Review this diff. List blocking issues only.

      {last}
    wait: done
    timeout: 900
`,
  },
];

/** Writes seeds into workflowsDir; never overwrites existing files. */
export async function seedWorkflows(
  workflowsDir: string,
  agent: string,
  seeds: Seed[] = [...PLAYBOOK_SEED_WORKFLOWS, ...REPO_SEED_WORKFLOWS],
): Promise<string[]> {
  const written: string[] = [];
  await mkdir(workflowsDir, { recursive: true });
  for (const seed of seeds) {
    const file = join(workflowsDir, `${seed.name}.yaml`);
    if (await Bun.file(file).exists()) continue;
    await Bun.write(file, seed.body(agent));
    written.push(seed.name);
  }
  return written;
}
