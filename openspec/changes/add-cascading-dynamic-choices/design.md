# Design

## Context

The three input widgets (`text`, `choice`, `profile`) compose through two mechanisms: `when:` guards over earlier answers, and dynamic choices that run a command for options. The spec currently forbids the combination — "Dynamic choice argv MUST reject templates ... MUST receive no partially collected input exports" — so a discovery command can never depend on an earlier answer. Meanwhile collection is strictly sequential in declaration order, guards already prove earlier-input existence (`Guarded sequential input collection`), and the picker already discards later answers and resolved domains when an earlier value changes (`Input navigation preserves valid answers`). Every structural prerequisite for cascading exists. Only the template ban stands in the way.

## Goals / Non-Goals

Goals:

- Dynamic choice argv elements accept `{{inputs.<earlier>}}` templates, substituted before execution.
- Load-time safety: forward and self references fail, and references to conditional inputs require matching guards.
- `hwf workflow inspect --resolve` stays honest about dependent choices it cannot resolve.

Non-goals:

- `context.*` or `steps.*` references inside dynamic argv. Context ordering relative to collection is not pinned by the spec, and steps have not run yet. Both stay load errors.
- New widget types (confirm, number, multi-select) — separate changes.
- Mid-run prompting or re-invoking collection after step 1. That is a run-model change, not an input feature.
- Exporting partial answers into the discovery command's environment. Substitution into argv is explicit and reviewable in the YAML, environment injection is not.

## Decisions

### D1: Values travel through argv substitution, not the environment

The existing rule "no partially collected input exports" stays. A referenced value appears exactly where the author wrote the template, so `hwf workflow inspect` output and sensitivity review read the true command. Rejected alternative: exporting collected `HWF_<name>` values to discovery commands — invisible in the YAML and it widens the surface for accidental leakage of half-collected state.

### D2: Reuse the guard-proof rule instead of a new activation model

Referencing a conditional input from dynamic argv follows the same rule that already governs conditional producer results and conditional input references: the consumer must carry every clause guarding the producer. Consequence: when the referenced input is inactive, the consuming input is provably inactive too, so a dependent choice never resolves against a missing value. No runtime null-handling is needed, the loader proves it.

### D3: Resolution order falls out of declaration order

Options for an input already resolve when its prompt is reached during sequential collection, and references point only backward, so every referenced value exists at resolution time. No dependency graph, no topological sort. Back-navigation correctness rides on the existing picker rule that discards later answers and later resolved domains when an earlier answer changes — the implementation must apply that same discard in `InputSession`, but the requirement already exists, so no picker-presentation delta.

### D4: Inspect prints what it cannot resolve

With `--resolve`, a dependent choice resolves only when its referenced inputs arrive through `--input`. Anything else would either guess values or silently skip the choice. Printing the unresolved argv keeps `inspect` a pure read that agents (the authoring skill validates through it) can trust.

### D5: Domain snapshots need no change

The picker resolves dependent domains during collection, after the referenced answers exist. The launch payload already snapshots resolved domains per input, and the detached run already validates selected values against snapshots without re-running discovery. Cascading changes what the domain depends on, not how it travels.

## Risks / Trade-offs

- **Injection surface**: an earlier answer flows into a command argument. Mitigated by argv-element substitution — the value lands as one argv element, never re-parsed by a shell, matching how list-form `run:` templates already work. An author who wraps the template in `sh -c` owns that risk today with step templates too.
- **Longer collection latency**: dependent choices resolve mid-collection, each under the existing 10-second timeout. A slow discovery command now blocks between prompts instead of before the first prompt. Accepted — the caps are unchanged and visible.
- **Authoring confusion between input guards and references**: a reference without a matching guard fails at load with the missing clause named, which teaches the rule at the point of error.

## Open Questions

None blocking. Default chosen: `allow_custom` composes unchanged with cascading choices, because custom values never enter the resolved domain and validation already handles them.
