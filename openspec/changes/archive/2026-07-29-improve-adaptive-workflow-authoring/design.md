## Context

Inputs are currently finalized while a workflow loads, the picker queues every declared input, and any `when` makes a step result statically unavailable. This keeps execution deterministic but forces mode-dependent workflows into irrelevant prompts, repeated steps, or hidden children. The change spans the parser, reference validator, input collector, runner, picker, detached launch payload, and CLI, while retaining four actions, strict linear execution, the existing template namespaces, and the Herdr denylist.

## Goals / Non-Goals

**Goals:**

- Collect only inputs active under earlier answers.
- Express simple conjunctions without an expression language.
- Reuse conditional results only when static guards prove availability.
- Cover closed-or-custom choices, non-empty values, input-selected pane placement, and expected probe exits.
- Resolve each active dynamic choice once per entry invocation.
- Improve picker correction and CLI discoverability.
- Keep existing `v1alpha1` files and behavior valid.

**Non-Goals:**

- General Boolean expressions, OR, parentheses, loops, parallel branches, switch actions, or a validation command DSL.
- Templates or partial input exports in dynamic-choice argv.
- Nullable or synthetic results for skipped steps.
- Changes to plugin method policy, Herdr protocol behavior, or configuration shape.
- General templating of every enum-valued workflow field.

## Decisions

### Represent conditions as ordered clauses

Parse the existing scalar `when` as one clause and a non-empty list as multiple clauses. Evaluate clauses in order with short-circuit AND semantics. Each clause keeps the existing truthiness or quoted equality representation, and validation rejects structured sources.

This is smaller and more readable than an expression parser. `!=` already covers the common two-branch grouping, while ordered clauses cover mode-plus-probe gates.

### Prove conditional availability by syntactic containment

Associate each conditional input and step producer with its normalized clauses. A reference is valid only when every producer clause appears in the consumer's proven clauses. For a reference inside `when`, only earlier clauses count as proven, which guarantees runtime short-circuiting never reads a missing value.

Clause comparison is structural after parsing, not raw YAML text, but performs no logical inference. Equivalent conditions written in different forms can be rejected; authors can repeat the same simple clause. Skipped steps remain result-less, so unguarded and weaker consumers keep failing at load.

### Collect inputs sequentially outside workflow loading

Loading parses input declarations, validates dependencies and static domains, and leaves dynamic options unresolved. A shared async collector walks declarations in order, evaluates each input guard from already collected values, skips inactive inputs, validates active supplied/default values, and resolves active dynamic choices only when needed.

The picker calls the collector incrementally. Direct CLI runs and child invocations use the same rules non-interactively. Dynamic-choice argv remains template-free and receives no partial `HWF_*` environment, preserving discovery independence and avoiding a second dependency language.

### Carry picker-resolved dynamic domains into the detached run

Extend the stdin launch payload with resolved dynamic option arrays keyed by active input name. The detached runner loads without executing dynamic choices, verifies that each supplied snapshot belongs to a declared dynamic input, and validates the selected value against that snapshot. Direct CLI runs and child invocations resolve their own active domains once.

The payload is a local handoff, not an authorization boundary. Keeping the selected domain prevents nondeterministic re-resolution and removes the current duplicate command execution without serializing the complete loaded workflow.

### Add narrow input fields

`when` is valid only on mapped inputs and can reference earlier inputs. `allow_custom: true` is valid only on choices and turns the option list into picker suggestions while accepting other text. `min_length` is an opt-in non-negative integer checked for active values after collection. Inactive CLI values fail rather than being silently ignored.

This avoids changing the meaning of existing text and closed-choice inputs. Filesystem and plugin state remain ordinary leading probe steps because they are runtime facts, not input shape.

### Permit only statically closed placement templates

Allow `pane.open` to be a whole-value reference to an unconditional static choice input only when every option is `tab`, `beside`, or `below`. The loader rejects text, custom, dynamic, conditional, embedded, result, and context sources for this field.

This removes duplicated placed steps without moving enum validation to runtime or creating a general typed-field templating system.

### Add accepted exit codes to local commands

`success_codes` is a non-empty unique integer list on blocking local `run` actions and defaults to `[0]`. Process completion is successful only when it does not time out and its exit code is accepted. Spawn failures, capture overflow, and timeout stay hard failures; placed and background runs reject the field. The natural command result remains available and `failed` reflects acceptance.

This provides a portable probe primitive without weakening `continue_on_error`, which must continue to make the complete workflow fail.

### Keep CLI and picker changes small

`hwf workflow inspect <name>` prints declarations without executing dynamic choices. Repeatable `--input` selects guarded paths, and `--resolve` executes active dynamic choices under their existing timeout, count, and capture limits. Inspection does not perform Herdr protocol preflight.

Picker Escape moves to the previous active input and restores its value. Changing an earlier answer discards later answers and option snapshots before recollection. Escape on a terminal run failure exits nonzero, matching Enter and the footer.

## Risks / Trade-offs

- [Guard containment rejects some logically safe forms] -> Keep diagnostics explicit and document repeating the producer clauses.
- [Conditional collection touches several callers] -> Centralize it in one workflow input module and test picker, direct CLI, and children against the same behavior.
- [Dynamic choices are trusted commands and can have side effects] -> Execute only active choices once and document that option discovery commands must be read-only.
- [Launch payload domains can become stale if YAML changes mid-launch] -> Reload and validate declaration names and types; preserve the chosen snapshot for deterministic execution.
- [`allow_custom` weakens a choice domain intentionally] -> Require an explicit field and expose it in picker and CLI inspection.
- [Placed split argv remains limited by Herdr 0.7.5 interactive-shell transport] -> Do not broaden this change into a launcher sidecar; retain the existing Windows beta claim and test the new features with shell-free argv.

## Migration Plan

Regenerate the workflow JSON schema and examples after parser changes, then update reference and authoring documentation. Existing `v1alpha1` documents require no rewrite. Rollback consists of reverting the plugin release; workflows using the new optional fields will receive the existing positioned unknown-key or enum errors on older releases.

## Open Questions

None. Deliberately deferred requests need a concrete workflow that the selected primitives cannot express.
