---
name: codebase-sanity-check
description: Whole-repository overhaul review for herdr-workflows. Use when asked to audit, clean up, overhaul, or `sanity check` this codebase, to raise its engineering standards, to check the docs against the code, or to review a branch before a pull request. For development of this herdr-workflows repository.
---

# Codebase review

One maintainer reads this repository. The review exists to keep it readable by one person, honest
about its own contract, and cheap to contribute to. It is not a style audit.

Derive the root from any cwd inside the repository with `git rev-parse --show-toplevel`. Do not
assume a fixed absolute path.

## Ground rules

Read these before Phase 0. They decide which findings survive.

**1. The gates are the oracle, not a rubric.** `go test ./...`, the Go verify scripts under `scripts/verify-*`, the loader, `npm run build` in `docs/`, and
`openspec validate` answer questions objectively. A finding that contradicts gate output is wrong.
A claim that a check "would fail" is worthless until the check ran.

**2. Deletion is free. Addition is on trial.** A recommendation to delete needs one line of
evidence that nothing depends on the thing. A recommendation to add a file, dependency, check,
abstraction, doc section, test, or config key goes through Phase 3 and dies there unless it earns
its place.

**3. No finding without `file:line`.** No line number means no finding. The one exception is a DELETE
of a whole file or directory, which cites the path alone — there is no meaningful line in a file that
should not exist. When a finding claims a command behaves a certain way, quote the shortest decisive
line of real output.

**4. Never weaken a check to clear a finding.** Raising a threshold, adding a `verify.config.json`
ignore, skipping a test, or widening a type to make the gate green is itself a critical finding.
See [criteria-risk.md](criteria-risk.md).

**5. Three sources, one truth.** `openspec/specs/*/spec.md` is the spec of record, `internal/` is the
truth about behavior, `docs/` describes the contract to users. When they disagree, the finding must
name **which one is wrong**, not merely that they differ.

**6. herdr runtime behavior comes from the reference checkout.** Any claim about herdr must cite a
path under `.agents/references/herdr/website/src/content/docs/`. Recalled herdr behavior is not
evidence. If the checkout is absent, follow `.agents/references/AGENTS.md` first.

**7. File count is a cost, not a virtue.** This repository has been over-split before. Splitting a
file to lower a complexity score is a defect, not a cleanup. See
[criteria-code.md](criteria-code.md) before proposing any new file.

**8. At most four sub-agents per run.** Three review, plus a dedicated judge when any group raised
an ADD. 23,000 lines and three runtime dependencies do not need a fleet.

## Phase 0: Establish the oracles

Entry: invocation received.
Exit: gate output and shape metrics captured, red gates recorded as findings.

Run `git status --porcelain` before anything else and read it. Another agent or an unfinished edit
may own this working tree. This review leaves no file modified, and no git ref, remote, branch, or
stash changed. A clean `git status` is not proof of that — a fetch moves a ref and prints nothing.

Then run these from the repository root. Capture output to the scratchpad. Do not skip a command
because it "should pass" — the point is measurement. All four are read-only: `CI=1` makes verify
check instead of auto-fixing, and the docs build writes only gitignored paths.

```bash
go test ./...
go run ./scripts/verify-prose
go run ./scripts/verify-no-archive
go run ./scripts/verify-file-length
go run ./scripts/verify-comments
npm ci --prefix docs && npm run build --prefix docs
openspec validate --all --strict
```

Then check that generated artifacts still regenerate to identical bytes:

```bash
git status --porcelain -- docs/workflow.schema.json
go run ./scripts/generate-workflow-schema
git diff --stat -- docs/workflow.schema.json
git checkout -- docs/workflow.schema.json
```

Skip this check and report "Not measured" when that scoped `git status` — the one limited to those two
paths — prints anything. A generated file that was already modified makes the diff meaningless.
Untracked files elsewhere in the tree are normal and do not skip the check. Otherwise a non-empty diff means a generated artifact was
hand-edited or a source drifted. That is a finding in Group B, the diff is the evidence, and the
final `git checkout` restores the tree either way.

Then capture shape metrics, which several groups consume:

```bash
find internal -name '*.go' | wc -l
find internal -name '*.go' | xargs wc -l 2>/dev/null | sort -rn | head -20
```

**A red gate outranks every opinion.** If `go test ./...` or a Go verify script fails, report that first,
with the failing name and the shortest decisive output line, and continue the review — do not stop.

If a command is unavailable (no `openspec` CLI, no herdr reference checkout), say so in the report
under a "Not measured" heading. Never infer the result.

## Phase 1: Scope

| Invocation | Scope                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| bare       | whole repository. Group C stops after section 6, which is where the diff sections start |
| `branch`   | `git diff origin/<default>...HEAD`. Group C runs all eleven sections                    |

Any other words in the invocation narrow the review rather than changing it. Pass them verbatim to
all three agents. Narrowing never removes an agent — a group with nothing to say returns nothing,
which costs less than deciding in advance that it had nothing to say.

**Pick the scope deliberately.** A bare run measured $10 against a branch run's $6, on fewer findings,
because the whole repository has more to read. It is also the only invocation that audits standing
risk: an unpinned GitHub Action, an unlinked doc page, or a dead spec capability sits in unchanged
files, so no `branch` run will ever surface it. Use `branch` before a pull request. Use bare when you
want the standing state, and expect to pay for it.

For `branch`: resolve the default branch with
`gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo main`. If
already on it, say so and review the whole repository instead. Capture both `--name-only` and the
unified diff, and pass the diff to sub-agents so they do not re-derive changed lines. Report only on
changed lines, except where a change breaks unchanged code.

**Read the base ref as it stands.** `git fetch`, `git remote update`, and `git pull` are forbidden for
the whole run. A fetch force-updates `origin/<default>` and silently rewrites the review scope, so the
report then describes a diff the maintainer never asked about. A stale base ref is the correct input.
Say so in the report when `origin/<default>` is behind.

Narrowing prioritizes findings inside a group's criteria. It never licenses skipping the criteria of
a group that is running.

## Phase 2: Dispatch

Entry: scope resolved, gate output captured.
Exit: every group has returned findings.

| Group | Name                | Criteria file                          | Covers                                                                                                   |
| ----- | ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A     | Code & Tests        | [criteria-code.md](criteria-code.md)   | over-splitting, dead abstractions, duplication, dead code, comments, test power, mock abuse              |
| B     | Truth & Enforcement | [criteria-truth.md](criteria-truth.md) | specs against code against docs, generated artifacts, herdr claims, prose style, gate honesty, CI parity |
| C     | Risk & Regression   | [criteria-risk.md](criteria-risk.md)   | trust boundaries, caps, secrets, web surface, install path, and on a branch the copout patterns          |

Each group's brief is wide on purpose. Three review agents is the cap, so coverage comes from depth
inside a brief rather than from more briefs. Tell each agent to work its sections in order and not
stop early.

Build all three prompts from the template below. Do not load a criteria file into your own context.
Pass the path. Each agent reads its own.

Prompt template:

```
You review the herdr-workflows repository for **{GROUP_NAME}**.

Repository root: {REPO_ROOT}
Read {REPO_ROOT}/AGENTS.md first. Its "Hard constraints" section overrides your priors.

## Scope
{SCOPE_DESCRIPTION}

{IF branch:}
### Changed files
{CHANGED_FILES}
### Unified diff
{DIFF_TEXT}
Report only on changed lines, unless a change breaks unchanged code.

{IF the invocation narrowed the review:}
### User words (verbatim)
{USER_TEXT}
Prioritize findings that serve this intent. Do not skip your own criteria.

## Gate output already measured (do not re-run)
{GATE_OUTPUT}
{SHAPE_METRICS}

## Instructions
1. Read your criteria file at {CRITERIA_PATH}.
2. Work every numbered section in order. Do not stop early — your brief is wide because this
   review runs three review agents, not seven. Use Read, Grep, Glob, and Bash. Run a command only when
   your criteria file names one and the output above does not already answer it. Never edit a file.
3. Every finding carries file:line. No line number, no finding.
4. Classify every finding as DELETE, FIX, or ADD.
   - DELETE removes code, files, config, dependencies, docs, or checks.
   - FIX changes existing code or prose in place, no net new surface.
   - ADD introduces any new file, dependency, check, abstraction, doc section, or config key.
5. For every ADD, supply the three-why chain (see below). If you cannot complete it, drop the
   finding yourself and do not report it.
6. Report a passing section as one line: "No findings in {section}."

## The three-why chain (ADD findings only)
Answer in order. Each answer must cite evidence, not intent.
  why 1 — what breaks today without this? Name the failure and where it is observable.
  why 2 — why does no existing gate, helper, dependency, stdlib call, or doc already cover it?
           Name what you checked.
  why 3 — why is this the smallest form? Name the smaller version you rejected and why.
Any answer that reduces to consistency, best practice, future-proofing, completeness, symmetry, or
taste fails. Drop the finding.

## Severity
- Critical: security hole, data loss, a red gate, a documented contract the code does not honor
- High: a rule with no enforcing site, a doc that teaches users something false, a test that
  cannot fail
- Medium: real reading cost — duplication of one rule in two places, an abstraction with one caller
- Low: local nits with a measurable but small cost

## Output format
### {GROUP_NAME} findings
**Summary:** {N} findings ({C} critical, {H} high, {M} medium, {L} low) — {d} DELETE, {f} FIX, {a} ADD

#### Finding {n}
- **Class:** DELETE | FIX | ADD
- **Severity:** Critical | High | Medium | Low
- **Location:** `{file}:{line}`
- **Evidence:** {measured output, quoted contract line, or call-site count}
- **Issue:** {one or two sentences}
- **Change:** {the concrete edit}
- **Three-why:** {ADD only — the chain}
```

## Phase 3: Adversarial gate

Entry: all group findings collected.
Exit: every ADD is upheld or discarded, with the reason recorded.

Spawn one dedicated judge — the fourth and last agent of the run. It takes every ADD finding from all
three groups in a single batch. Do not rotate the review agents into this role and do not spawn a
judge per group.

The judge reads no criteria file. It arrives with no stake in any finding and no group's reading of
the repository, which is the whole point. Skip this phase only when no group produced an ADD finding.

Send it every ADD finding, the repository root, and this instruction:

```
Try to kill each ADD finding below. Default to discard.

For each one:
1. Re-run its why-three-times chain against the real repository. Check the claim yourself. Do not
   trust the quoted evidence.
2. Discard when any answer rests on consistency, best practice, future-proofing, completeness,
   symmetry, or taste.
3. Discard when an existing gate, helper, dependency, stdlib call, or document already covers it.
   Name what covers it.
4. Discard when a smaller form exists — a deletion, a one-line change, or a sentence in a file that
   already exists.
5. Uphold only with a named observable failure that exists today.

Return: upheld (with the surviving chain) and discarded (with the answer that failed).
```

DELETE and FIX findings skip this phase. They shrink surface, so the burden of proof is on keeping
the thing, not on removing it.

Discarded ADDs go in the report. A rejected idea that is not written down comes back next run.

## Phase 4: Collate

1. Merge findings. On the same `file:line`, keep the higher severity and merge text.
2. Drop any finding that Phase 0 output contradicts.
3. Order: red gates, then Critical, High, Medium, Low. Within a severity, DELETE before FIX before ADD.
4. Count per severity, per class, and per group.

## Phase 5: Output

```markdown
# Codebase sanity check

## Gates

| Gate | Result | Evidence |
(one row per Phase 0 command, plus a "Not measured" row for anything unavailable)

## Summary

- **Scope:** {whole repository | branch}, {N} files, {G} groups
- **Findings:** {total} ({C} critical, {H} high, {M} medium, {L} low)
- **Classes:** {d} delete, {f} fix, {a} add upheld, {x} add discarded

## Critical

## High

## Medium

## Low

(each: Location, Evidence, Issue, Change)

## Discarded additions

| Proposal | Which why failed | Why it failed |

## Clean

(criteria sections with no findings, one line each)
```

A finding that changes runtime behavior names the OpenSpec capability under `openspec/specs/` that
must be updated first — see `CONTRIBUTING.md`.
