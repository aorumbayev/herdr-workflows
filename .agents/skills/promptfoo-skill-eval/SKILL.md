---
name: promptfoo-skill-eval
description: Measures whether a user-facing agent skill in this repository actually works, by running real agent sessions against two skill versions side by side and scoring the YAML they produce through the real hwf loader instead of an LLM judge. Use when asked to test, evaluate, benchmark, or improve a skill under skills/ — for example herdr-workflow-create — or to check whether a skill is still accurate after the loader, grammar, or herdr policy changed. For development of this herdr-workflows repository.
---

# Evaluate a user-facing skill with promptfoo

`skills/herdr-workflow-create/` teaches an agent to write workflow YAML. Whether it _works_ is a
measurable question: run the same tasks against two versions of the skill text, and check whether
the YAML each produced actually loads.

This skill belongs to the herdr-workflows repository. From any cwd inside it, derive the root with
`git rev-parse --show-toplevel`. Do not assume a fixed absolute path.

## What makes this eval trustworthy

**The oracle is the loader, not a rubric.** Every ```yaml fence the agent emits is loaded through
`src/workflow/load.ts` with the fixture's own `.hwf/workflows/` seeded so `workflow:` children
resolve. A workflow either loads or it does not. Do not replace this with an LLM judge — the whole
point is that this repository can answer the question objectively.

**Establish the noise floor before believing any delta.** Run iteration 1 with the two fixtures
holding _identical_ skill text. The spread you get is the noise floor; on this repo it measured
±0.02. A later improvement smaller than that is not an improvement. Skipping this step is how an
eval starts producing confident nonsense.

**Turn count is often the real signal.** Two versions can both reach a loading workflow while one
takes 16 turns and the other 6, because the first had to discover a rule by failing. Score alone
hides that. Report cost and turns alongside it.

**A win you tuned toward is not a measurement.** If you edit the skill _after_ seeing the final
number, the number no longer describes that text. Either re-run, or state plainly that the edit is
unmeasured.

## Layout

```
<scratchpad>/skill-eval/
├── promptfooconfig.yaml            # copy from promptfooconfig.example.yaml here
├── promptfooconfig.adversarial.yaml
└── fixtures/
    ├── v1/.claude/skills/<name>/   # the shipped skill, unmodified
    └── v2/.claude/skills/<name>/   # the candidate
```

Build fixtures in a scratchpad, not in the repo. Only `SKILL.md` and `reference/` may differ
between v1 and v2 — same model, same tasks, same permissions, or the comparison means nothing.

## Provider

The documented path is `anthropic:claude-agent-sdk` with `setting_sources: ['project']` and a
`skills:` filter, which gives promptfoo's built-in `skill-used` / `not-skill-used` assertions.
It needs `ANTHROPIC_API_KEY`.

Without a key, `scripts/provider.js` shells out to the locally authenticated `claude -p
--output-format stream-json`, one provider instance per fixture differing only in `working_dir`.
Two consequences to state in any report that uses it:

- built-in `skill-used` is unavailable, so `scripts/assert-skill.js` reads `Skill` tool calls out
  of the stream instead;
- fixture isolation is weaker, because the user's own installed skills stay visible to the agent.

`max-score` is a _comparative_ selector — it fails the loser of each test rather than grading
against a threshold. For absolute weighted scores use `scripts/regrade.js`.

## Tasks

Cover how the skill is really used, then attack it:

1. **Happy path** — a simple two-step workflow.
2. **Inputs** — needs a `when:` guard and a described input.
3. **A `herdr:` step** — the policy is default-deny by exact method name, so this is where an
   out-of-date skill fails.
4. **`on_failure`** — entry-only, one action.
5. **Under-specified** — does the skill ask, or invent?
6. **Traps**, one per rule the loader enforces silently: a hyphenated step `id:` or input name,
   `pane.size` with `open: tab`, an unused input, an untargeted `herdr:` call, a `ready_when` with
   regex flags, a placed `run:` with neither `background:` nor `ready_when:`.
7. **Routing** — a near-miss prompt that belongs to a sibling skill
   (`.agents/skills/herdr-workflows-smoke-test/`), asserted with `not-skill-used`.

Each trap the agent only escapes by failing and retrying is a gap in the skill text. That gap, not
the score, is the finding.

## Run it

```bash
root=$(git rev-parse --show-toplevel)
cd <scratchpad>/skill-eval
sh "$root/.agents/skills/promptfoo-skill-eval/scripts/reset-fixtures.sh"
promptfoo eval -c promptfooconfig.yaml --no-cache -o iter.json --max-concurrency 1
node "$root/.agents/skills/promptfoo-skill-eval/scripts/regrade.js" iter.json
```

`--max-concurrency 1` matters whenever a skill under test writes to a fixed draft path: parallel
sessions overwrite each other's draft and the failures look like model errors. `reset-fixtures.sh`
kills stray `hwf web` servers, so never run it while an eval is in flight.

Add `--repeat 3` when a result sits near the noise floor.

## Reporting

State for every number whether it came from a real agent run or from reading code. Include the
noise-floor iteration, the score trajectory across iterations rather than only the final figure,
any grading bug you found and fixed, and any regression the winning version introduced. An honest
"could not execute, here is what I ran instead" is worth more than an invented figure.

Adopt a candidate only after `bun test ./test/skill-snippets.test.ts` passes against it — that gate
loads every fence in the skill through the loader — followed by `CI=1 bun run verify`.
