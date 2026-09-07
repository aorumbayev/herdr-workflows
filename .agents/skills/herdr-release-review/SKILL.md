---
name: herdr-release-review
description: Evidence-backed review of a new herdr release against this plugin — break verdict first, then every API, protocol, and behavior change that touches this codebase, then new features worth adopting. Raise min_herdr_version only when a sandbox or CLI run reproduces a regression that the old server cannot keep speaking. Use when herdr X.Y.Z is out, when asked "does the new herdr break us", to review the new herdr release, or to run the protocol upgrade path. For development of this herdr-workflows repository.
---

# herdr release review

A new herdr version is out. Answer three questions with evidence, not memory: does the current
plugin break against it, what changed in the API, protocol, and behavior this codebase depends on,
and which new features let the plugin shrink or improve. Every claim in the report ties to a tag
diff, a schema diff, or a sandbox run.

This skill belongs to the herdr-workflows repository. Derive the root from any cwd inside it with
`git rev-parse --show-toplevel`. Do not assume a fixed absolute path. Never invent herdr behavior
from memory — the reference checkout at `.agents/references/herdr/` is the source.

## Phase 0: Pin the reference checkout at the release tag

Follow `.agents/references/AGENTS.md` (clone URL, fetch, safety rules), then detach at the release:

```bash
git -C .agents/references/herdr fetch origin --tags
git -C .agents/references/herdr switch --detach vX.Y.Z
```

- If `git fetch` fails with a lock error on `origin/<default-branch>`, the ref is stale. Remove the
  stale ref file or run `git -C .agents/references/herdr remote prune origin`, then fetch again.
- The checkout may lack a `docs/versions/<new>` snapshot — upstream restructured versioned docs.
  Live docs at the tag are `website/src/content/docs`.
- Record the floor tag too: `min_herdr_version` in `herdr-plugin.toml` names it
  (`v<min_herdr_version>`). Every diff below runs floor tag against release tag — never the
  adjacent previous release, because every release between the floor and the new tag is also new
  to this plugin.

## Phase 1: Classify the changelog

Read the release's section of `CHANGELOG.md` in the checkout. Sort every entry into: breaking, API
addition, behavior change, housekeeping (org, license, docs), or irrelevant to this plugin
(TUI-only, Windows-only — the plugin is POSIX with WSL2). Quote entries. Do not paraphrase from
recall, and do not report an entry the file does not contain.

## Phase 2: Diff the wire protocol

```bash
git -C .agents/references/herdr diff v<floor> vX.Y.Z -- src/protocol/wire.rs
```

Run the diff — reading a file at whatever commit the checkout sits on is not evidence of what
changed between the tags. Compare `PROTOCOL_VERSION` between the tags. Ping reports that integer.
The plugin accepts an integer `connected >= Protocol`, where `Protocol` in
`internal/host/herdr_methods.gen.go` is the generated floor from `schemas/herdr-api.schema.json`.
A higher number is not a break verdict and does not refuse socket calls. A lower number than the
floor still fails (`herdr protocol mismatch: connected=…, pinned=…`). CLI-mediated paths do not
use this gate.

Record both integers. Do not raise `min_herdr_version` from this diff alone.

## Phase 3: Diff the API schema surface

Two independent reads, both required:

1. Source diff in the checkout:
   `git -C .agents/references/herdr diff v<floor> vX.Y.Z -- src/api/schema.rs src/api/schema/`
2. After installing the new herdr binary, capture `herdr api schema --json` and structurally diff
   it against `schemas/herdr-api.schema.json`: protocol number, added or removed method consts,
   added enum values (for example new `IntegrationTarget` agent kinds), changed param or result
   shapes.

Additive versus breaking is the key verdict per item. An added method or enum value is an
opportunity. A removed or reshaped one is a break for whatever in `internal/host/`, `internal/engine/`,
or the workflow grammar names it — grep before claiming impact.

## Phase 4: Upgrade path

Default: keep `min_herdr_version` and the generated `Protocol`. The running plugin already accepts
a newer ping protocol. A `PROTOCOL_VERSION` bump, a changelog "breaking" line, or an unused schema
change is not a floor bump.

### Adopt methods without moving the floor

Run steps 1, 2, and 6 when the plugin should expose new methods or enum values. When you copy a
newer `herdr api schema --json`, leave the file's `protocol` field at the current floor `Protocol`.
The generator writes that field to `const Protocol`. Raising it makes `connected >= Protocol` refuse
every older server, which is a silent floor bump.

### Raise the floor only with a reproduced regression

Run steps 3 and 4 only when a sandbox or quoted CLI run shows a genuine failure that you cannot
fix while the plugin still speaks the other herdr:

- The current plugin fails on the new herdr, and the fix needs a call or param the floor server
  rejects.
- After that required fix, the new plugin fails on the floor herdr.

Quote the command and the error. No quote, no floor bump. Then raise `min_herdr_version` and the
schema `protocol` field together, regen, and sweep floor prose.

1. Copy the captured schema into `schemas/herdr-api.schema.json`. Keep `protocol` at the floor
   unless this run is a proven floor bump.
2. `go run ./scripts/gen-herdr-methods`. The generator fails naming any unmapped method
   (`no success result type mapped for method '…'`). Add the mapping in
   `METHOD_RESULT_TYPE_OVERRIDES` in `scripts/gen-herdr-methods/main.go`, taking the real result
   variant from the herdr handler source (for example `workspace.move_block` returns
   `workspace_list`), then rerun.
3. Raise `min_herdr_version` in `herdr-plugin.toml` only after that reproduced failure.
4. Floor-bump only: update the protocol floor test in `internal/host/startup_test.go` and
   `internal/host/result_paths_test.go` (`Protocol` still names the floor) and the fake-herdr
   `ping` fixture in `e2e/` when examples still run there.
5. `go tool verify` must pass before the review is done when you changed code.
6. Refresh what the regenerated table feeds. `skills/herdr-workflow-create/reference/herdr-api.md`
   hand-lists the allowed methods with their counts, version pin, and per-method selectors — a
   regen without this refresh teaches authors a stale API. Take new selectors from
   `HERDR_FOCUS_POLICY` in the regenerated file. After a proven floor bump, sweep prose for the
   old floor: `grep -rn "<old version>" README.md AGENTS.md CONTRIBUTING.md docs skills` and move
   every stated floor, docs pin, and "as of herdr X.Y.Z" sentence to the new release. Skip that
   sweep when the floor stayed.

## Phase 5: Prove it live

Use the `.agents/skills/herdr-workflows-smoke-test/` sandbox — never bare `herdr`/`hwf`, always
`hsb`, and never stop the user's live herdr server. Bring the sandbox up on the new herdr. Do not
expect `protocol_mismatch` from a newer ping protocol. A pass on the current plugin is evidence
the floor stays. A fail is the only evidence that may move the floor. Capture the output either
way. Then rebuild if you changed the plugin and rerun:

- the sandbox self-check;
- a workflow with a `herdr:` action;
- a placed `run:` with `ready_when` — headless `hwf run` has no invocation pane, so placement
  needs an explicit `workspace:`/`target:` anchor;
- a result-validated list call;
- the picker, through `herdr plugin action invoke launch --plugin herdr-workflows`.

If the sandbox cannot run (no new binary installed, user declined), report those steps under "Not
measured" — never infer their result.

## Mixed-state hazards

The procedure itself creates windows where things look broken. Warn the user before entering them:

- The herdr installer replaces the live binary while the old server keeps running. Every CLI call
  reports `protocol_mismatch` until the server restarts, and stopping the server exits its pane
  processes — the user restarts on their own schedule.
- `go run ./scripts/install-dev` rebuilds the shared `bin/herdr-workflows`, breaking the user's live picker
  until they restart herdr. Its plugin-link step fails against the still-running old server —
  rerun it after the restart.

## Report

Lead with the break verdict, then five sections:

1. **Breaking** — each with a reproduced run or a schema change the plugin sends, and its fix.
   A protocol integer bump without a failed run is not Breaking. Put it under Behavior changes
   to watch. A floor bump belongs here only with the quoted error from Phase 4.
2. **API additions** — as opportunities to simplify or refine the plugin, each naming the plugin
   code it could replace or improve.
3. **Behavior changes to watch** — no code change now, but a contract this plugin relies on moved.
4. **Workflow-author impact** — changes that break YAML users have already written in consumer
   repos while the plugin itself stays fine after regen: removed target inference, newly required
   params, uniqueness constraints, changed defaults. The 0.8.0 review found all three of its
   real-world breakages in this class. Name the affected step patterns and the rewrite for each.
5. **Housekeeping** — org, license, docs churn. One line each.

Every claim carries its evidence: the tag diff hunk, the schema diff entry, or the sandbox output
line. Cite files repo-relative with a line number (`internal/host/rpc.go:220`, not `rpc.go:220`), and cite
files inside the reference checkout with their full prefix
(`.agents/references/herdr/CHANGELOG.md:5`), so every citation resolves from the repository root.
A claim with no diff and no run does not go in the report.
