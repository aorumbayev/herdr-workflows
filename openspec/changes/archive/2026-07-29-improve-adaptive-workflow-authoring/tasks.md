## 1. Condition And Input Model

- [x] 1.1 Extend workflow types and Zod parsing for condition lists, mapped input `when`, `allow_custom`, `min_length`, local-run `success_codes`, and whole-value `pane.open` templates, with positioned rejection tests for invalid combinations.
- [x] 1.2 Update reference validation to reject structured conditions and prove conditional input and step-result availability through ordered structural guard containment, with accepted and rejected guard tests.
- [x] 1.3 Add static `pane.open` source-domain validation for unconditional closed static choices and tests covering valid placement choices and every unbounded source kind.

## 2. Sequential Input Collection

- [x] 2.1 Refactor input collection into one shared sequential path that evaluates active inputs, defaults, closed/custom choices, minimum lengths, profiles, and dynamic options for entry and child workflows.
- [x] 2.2 Stop resolving dynamic choices during executable workflow loading, preserve listing and validation behavior, and test inactive and direct-CLI dynamic choices execute at most once.
- [x] 2.3 Extend detached launch payload validation with resolved dynamic domains and test picker-selected domains are reused once, remain off argv, and reject mismatched snapshots.

## 3. Runner Semantics

- [x] 3.1 Evaluate condition lists with ordered short-circuit AND semantics while preserving scalar `when`, skipped-step logging, and recovery behavior.
- [x] 3.2 Implement blocking local-run `success_codes`, preserving hard spawn, timeout, and capture failures and rejecting placed or background use.
- [x] 3.3 Resolve statically validated `pane.open` input templates before pane creation and cover tab, beside, and below placement dispatch.

## 4. Picker And CLI Ergonomics

- [x] 4.1 Make the picker collect only active inputs, offer an explicit custom-choice text path, and retain resolved dynamic domains for launch.
- [x] 4.2 Implement Escape backtracking with answer restoration and later-state invalidation, plus consistent nonzero dismissal after run failure.
- [x] 4.3 Add `hwf workflow inspect <name>` with repeatable `--input` and optional `--resolve`, generated Commander help, and tests proving static inspection runs no discovery command or workflow step.

## 5. Schema, Documentation, And Verification

- [x] 5.1 Regenerate `docs/workflow.schema.json`, update examples where they clarify the new syntax, run `bun run examples` when examples change, and document guarded inputs, conjunctions, custom choices, placement selection, probes, inspection, and dynamic-choice purity.
- [x] 5.2 Run focused workflow, runner, picker, launch, and CLI tests, then run `bun test ./test` and `npm run verify`.
- [x] 5.3 Run `openspec validate --change improve-adaptive-workflow-authoring` and resolve every artifact or requirement error.
