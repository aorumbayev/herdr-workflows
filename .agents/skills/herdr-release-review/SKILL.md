---
name: herdr-release-review
description: Evidence-backed review of a new herdr release against this plugin — break verdict first, then every API, protocol, and behavior change that touches this codebase, then new features worth adopting. Use when herdr X.Y.Z is out, when asked "does the new herdr break us", to review the new herdr release, or to run the protocol upgrade path. For development of this herdr-workflows repository.
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
changed between the tags. Compare `PROTOCOL_VERSION` between the tags. The plugin pins `HERDR_PROTOCOL` in
`src/herdr-methods.generated.ts` and `src/host.ts` compares it with strict equality against the
`ping` response. Any protocol bump therefore means the plugin refuses every socket call
(`herdr protocol mismatch: connected=…, pinned=…`) while CLI-mediated paths keep working. A bump is
an automatic break verdict. State it as such.

## Phase 3: Diff the API schema surface

Two independent reads, both required:

1. Source diff in the checkout:
   `git -C .agents/references/herdr diff v<floor> vX.Y.Z -- src/api/schema.rs src/api/schema/`
2. After installing the new herdr binary, capture `herdr api schema --json` and structurally diff
   it against `schemas/herdr-api.schema.json`: protocol number, added or removed method consts,
   added enum values (for example new `IntegrationTarget` agent kinds), changed param or result
   shapes.

Additive versus breaking is the key verdict per item. An added method or enum value is an
opportunity. A removed or reshaped one is a break for whatever in `src/host.ts`, `src/engine/`,
or the workflow grammar names it — grep before claiming impact.

## Phase 4: Upgrade path

Run this phase when the protocol bumped. Run steps 1, 2, and 6 alone when the schema gained
methods or enum values without a protocol bump and the plugin should adopt them — the floor and
the pin stay put in that case.

1. Copy the captured schema into `schemas/herdr-api.schema.json`.
2. `bun run schema:herdr`. The generator fails naming any unmapped method
   (`no success result type mapped for method '…'`). Add the mapping in
   `METHOD_RESULT_TYPE_OVERRIDES` in `scripts/generate-herdr-methods.ts`, taking the real result
   variant from the herdr handler source (for example `workspace.move_block` returns
   `workspace_list`), then rerun.
3. Raise `min_herdr_version` in `herdr-plugin.toml` — a plugin pinned to the new protocol cannot
   speak to the old server, so the floor moves with the pin.
4. Update the protocol pin test in `test/host/herdr-methods.test.ts` and the fake-herdr `ping`
   fixture in `test/e2e/examples-harness.ts`.
5. `bun test ./test` and `CI=1 npm run verify` must pass before the review is done.
6. Refresh what the regenerated table feeds. `skills/herdr-workflow-create/reference/herdr-api.md`
   hand-lists the allowed methods with their counts, version pin, and per-method selectors — a
   regen without this refresh teaches authors a stale API. Take new selectors from
   `HERDR_FOCUS_POLICY` in the regenerated file. Then sweep prose for the old floor:
   `grep -rn "<old version>" README.md AGENTS.md CONTRIBUTING.md docs skills openspec` and move
   every stated floor, docs pin, and "as of herdr X.Y.Z" sentence to the new release.

## Phase 5: Prove it live

Use the `.agents/skills/herdr-workflows-smoke-test/` sandbox — never bare `herdr`/`hwf`, always
`hsb`, and never stop the user's live herdr server. Bring the sandbox up on the new herdr. Expect
the old plugin build to fail with `protocol_mismatch` — that failure is evidence, capture it. Then
rebuild and rerun:

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
- `bun run install:dev` rebuilds the shared `bin/herdr-workflows`, breaking the user's live picker
  until they restart herdr. Its plugin-link step fails against the still-running old server —
  rerun it after the restart.

## Report

Lead with the break verdict, then five sections:

1. **Breaking** — each with its fix (usually Phase 4).
2. **API additions** — as opportunities to simplify or refine the plugin, each naming the plugin
   code it could replace or improve.
3. **Behavior changes to watch** — no code change now, but a contract this plugin relies on moved.
4. **Workflow-author impact** — changes that break YAML users have already written in consumer
   repos while the plugin itself stays fine after regen: removed target inference, newly required
   params, uniqueness constraints, changed defaults. The 0.8.0 review found all three of its
   real-world breakages in this class. Name the affected step patterns and the rewrite for each.
5. **Housekeeping** — org, license, docs churn. One line each.

Every claim carries its evidence: the tag diff hunk, the schema diff entry, or the sandbox output
line. Cite files repo-relative with a line number (`src/host.ts:220`, not `host.ts:220`), and cite
files inside the reference checkout with their full prefix
(`.agents/references/herdr/CHANGELOG.md:5`), so every citation resolves from the repository root.
A claim with no diff and no run does not go in the report.
