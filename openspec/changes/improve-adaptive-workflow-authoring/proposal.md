## Why

Real repository workflows currently need irrelevant prompts, hidden child workflows, duplicated placed steps, and shell wrappers to express ordinary mode-dependent setup. The workflow format should cover those cases without weakening its linear execution model or static result-reference checks.

## What Changes

- Let mapped inputs declare ordered `when` conditions so only active inputs are collected.
- Let step `when` accept an ordered non-empty list with AND semantics while retaining the existing scalar form.
- Permit references to conditional inputs and step results only where the consumer's conditions statically include the producer's conditions.
- Add opt-in `allow_custom` and `min_length` input constraints for choice-or-text and non-empty input flows.
- Resolve active dynamic choices once per entry invocation and carry their resolved domains into detached picker runs.
- Allow `pane.open` to reference an unconditional closed static choice whose complete domain is `tab`, `beside`, or `below`.
- Add `success_codes` to blocking local commands so expected probe outcomes do not fail the workflow.
- Make Escape return to the previous active picker input without discarding prior answers.
- Add `hwf workflow inspect` for input metadata and optional dynamic-choice resolution.
- Reject structured `when` sources and make failed picker dismissal return nonzero, matching the existing specifications and UI text.
- Keep dynamic-choice argv independent of earlier answers, keep plugin methods denied, and add no general expression language, branch action, validation command DSL, loops, or parallelism.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-grammar`: Add guarded and adaptive input fields, single-resolution input collection, static placement templates, and accepted local-command exit codes.
- `step-control-flow`: Add ordered conjunctions and guard-aware availability while preserving result-less skipped steps and strict linear execution.
- `picker-presentation`: Preserve answers when navigating backward through active input prompts and report failed runs consistently.
- `hwf-cli`: Add workflow input inspection and carry resolved picker input domains through detached launch payloads.

## Impact

The change affects workflow parsing, reference validation, input loading and collection, local command result handling, picker state, detached launch payloads, CLI commands, the generated workflow schema, examples, and author documentation. Existing `v1alpha1` YAML needs no rewrite, but scripted callers must stop supplying values for inputs made inactive by earlier answers. No dependency is added, and the Herdr method denylist and protocol contract remain unchanged.
