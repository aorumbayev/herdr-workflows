---
name: promptfoo-skill-eval
description: Measures whether an agent skill in this repository works, by running real agent sessions against two skill versions side by side and scoring with objective oracles instead of an LLM judge. Use when asked to test, evaluate, benchmark, or improve a skill under skills/ or .agents/skills/ — for example herdr-workflow-create or codebase-sanity-check — or to check whether a skill is still accurate after the loader, grammar, or herdr policy changed. For development of this herdr-workflows repository.
---

# Evaluate a user-facing skill with promptfoo

`skills/herdr-workflow-create/` teaches an agent to write workflow YAML. Whether it _works_ is a
measurable question: run the same tasks against two versions of the skill text, and check whether
the YAML each produced loads.

This skill belongs to the herdr-workflows repository. From any cwd inside it, derive the root with
`git rev-parse --show-toplevel`. Do not assume a fixed absolute path.

## What makes this eval trustworthy

**The oracle is the loader, not a rubric.** Every ```yaml fence the agent emits is loaded through
`internal/workflow` with the fixture's own `.hwf/workflows/` seeded so `workflow:` children
resolve. A workflow either loads or it does not. Do not replace this with an LLM judge — the whole
point is that this repository can answer the question objectively.

**Establish the noise floor before believing any delta.** Run iteration 1 with the two fixtures
holding _identical_ skill text. The spread you get is the noise floor. On this repo it measured
±0.02. A later improvement smaller than that is not an improvement. Skipping this step is how an
eval starts producing confident nonsense.

**Turn count is often the real signal.** Two versions can both reach a loading workflow while one
takes 16 turns and the other 6, because the first had to discover a rule by failing. Score alone
hides that. Report cost and turns alongside it.

**A win you tuned toward is not a measurement.** If you edit the skill _after_ seeing the final
number, the number no longer describes that text. Either re-run, or state plainly that the edit is
unmeasured.

**A saturated score has no noise floor.** When both arms hit 1.000, the spread is 0.000 and it means
nothing — it is a ceiling artifact, not a floor. Say so rather than reporting it as a clean floor, and
move the reading to the metrics that still move. On `codebase-sanity-check` those were turns (4 vs 2),
cost ($9.08 vs $3.85), and one contract the skill broke in only some runs.

## Skills that do not emit YAML

The loader oracle only works when the skill's output is a workflow. A skill that emits a review, a
plan, or prose has no loader, and the eval skill's first rule still holds: no LLM judge. Build
objective oracles instead. These worked on `codebase-sanity-check`:

**Seeded-defect recall is the loader analog.** Clone the repository into a fixture, inject a defect
set recorded in a manifest _before_ the run, and score which defects come back cited. Found or not
found is as objective as loads or does not load. Split the set by tier — with a gate behind it, and
without — and report recall per tier, because gate-backed defects flatter the score.

**Score the contracts the skill states about itself.** Each of these is a scriptable pass or fail:
every `path:line` in the output resolves to a real line, the sub-agent count matches the stated cap,
`git status --porcelain` and the reflog are unchanged before and after, and a quoted gate result
matches the gate you ran yourself. Parse the raw `stream-json`, not the prose: a report saying it did
something is not evidence that it did.

**Precision needs the correct silence pre-registered.** Seed decoys the criteria explicitly call "not
a finding", record them before the run, and score how many were correctly ignored. Reporting a decoy
is objectively wrong, no judge required.

**Budget more for the decoys than for the defects.** Measured twice on this repo: 5 of 6 decoys were
invalid because each landed inside some _other_ flagging clause the author had not read closely. A
valid decoy is harder to build than a defect. Audit every candidate decoy against every criteria file
before the run, not only the one it was drawn from — otherwise precision stays unmeasured while
looking measured.

**Grade your own oracle before you trust its number.** Both iterations produced false failures from
the grader, never the skill: a citation regex that rejected `**path:line**` bold form, a table parser
reading the whole row instead of the result cell, and a token list too narrow for a correct answer
phrased differently. Re-score offline from saved streams when you fix one. Never re-run the agent to
fix your own arithmetic.

## Layout

```
<scratchpad>/skill-eval/
├── .promptfoo-skill-eval-owned     # ownership marker (required before reset)
├── promptfooconfig.yaml            # copy from promptfooconfig.example.yaml here
├── promptfooconfig.adversarial.yaml
└── fixtures/
    ├── v1/.claude/skills/<name>/   # the shipped skill, unmodified
    └── v2/.claude/skills/<name>/   # the candidate
```

Build fixtures in a scratchpad, not in the repo. Only `SKILL.md` and `reference/` may differ
between v1 and v2 — same model, same tasks, same permissions, or the comparison means nothing.

Ownership marker (write once when seeding the scratchpad. Paths must be absolute):

```bash
skill_root="$root/.agents/skills/promptfoo-skill-eval"
printf 'promptfoo-skill-eval\nskill_root=%s\n' "$skill_root" > .promptfoo-skill-eval-owned
```

`reset-fixtures.sh` cleans only under that owned eval root's `fixtures/v1` and `fixtures/v2`
(generated workflow YAML except `child-verify.yaml`, plus `.hwf/tmp`). It refuses missing or
mismatched markers, unknown trees, and symlink path components under the owned root. Dry-run
guards with `--guard-check`. It does not kill processes and does not delete shared `/tmp`
paths. Put agent draft files under `fixtures/<v>/.hwf/tmp/` so reset can remove them.

## Provider

The documented path is `anthropic:claude-agent-sdk` with `setting_sources: ['project']` and a
`skills:` filter, which gives promptfoo's built-in `skill-used` / `not-skill-used` assertions.
It needs `ANTHROPIC_API_KEY`.

Without a key, shell out to the locally authenticated `claude -p --output-format stream-json` from
your promptfoo config. Fixture isolation is weaker because the user's own installed skills stay
visible to the agent.

`max-score` is a _comparative_ selector — it fails the loser of each test rather than grading
against a threshold. Re-score saved promptfoo output offline when you adjust weights.

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

Supported maintainer invocation (eval root = the scratchpad directory that holds `fixtures/`):

```bash
root=$(git rev-parse --show-toplevel)
cd <scratchpad>/skill-eval
sh "$root/.agents/skills/promptfoo-skill-eval/scripts/reset-fixtures.sh"
promptfoo eval -c promptfooconfig.yaml --no-cache -o iter.json --max-concurrency 1
```

After each run, load every ```yaml fence through `go test` against the Go loader (or a small helper
that calls `internal/workflow`) before trusting the score.

`reset-fixtures.sh` defaults to the current working directory as the eval root. Pass an absolute
path as the first argument when the shell is elsewhere. Seed `.promptfoo-skill-eval-owned` before
the first reset (see Layout).

`--max-concurrency 1` matters whenever a skill under test writes to a fixed draft path: parallel
sessions overwrite each other's draft and the failures look like model errors. Do not run reset
while an eval is in flight — it deletes fixture workflow YAML under the owned tree.

Add `--repeat 3` when a result sits near the noise floor.

## Reporting

State for every number whether it came from a real agent run or from reading code. Include the
noise-floor iteration, the score trajectory across iterations rather than only the final figure,
any grading bug you found and fixed, and any regression the winning version introduced. An honest
"could not execute, here is what I ran instead" is worth more than an invented figure.

Adopt a candidate only after `go test ./...` passes against the skill's YAML fences through the Go loader — followed by the Go verify scripts (`go run ./scripts/verify-prose`, `verify-no-archive`, `verify-file-length`, `verify-comments`).
