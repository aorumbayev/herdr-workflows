## Context

Issue 54 listed seven idiom groups in `internal/`. Issue 55 adopts all of them as one alpha change. YAML, CLI argv, and main spec identifiers stay as they are. Intra-module exported Go names may break. AGENTS.md still binds: layers, comment and file-length gates, no extra abstraction.

## Goals / Non-Goals

**Goals:**

- Drop package-name stutter and fix `herdrCli` casing in one rename sweep.
- Handle errors at the listed sites: unused blanks, discarded marshal, flattened wraps, in-band empty strings.
- Declare the three listed empty slices as nil `[]string`.
- Keep `go tool verify` green.

**Non-Goals:**

- No rename of `WorkflowAction` or `cliResult`.
- No JSON nil-vs-empty change except the three listed slice sites.
- No idiom sites outside the audit.
- No aliases, shims, or migration for the old names.
- No new packages, helpers, or error types beyond `Unwrap` on `ReleaseCheckError`.

## Decisions

1. **One breaking rename sweep.** Apply the issue 55 from/to table plus `herdrCli` → `herdrCLI`. Alternative — aliases — rejected. Alpha allows the break. Call sites live in `internal/` and `scripts/build-examples`.
2. **Drop unused `RunsFooter` parameters.** Callers already pass position to `tui.FormatListFooter`. Naming them `_` would keep a lie in the signature. Alternative — keep unused names — rejected.
3. **Settle marshal failure like spawn failure.** `LaunchDetachedRun` checks `json.Marshal`. On error it settles `OK: false` with the error detail and does not write stdin. Alternative — log and continue — rejected. The audit says the empty write is the bug. Every `LaunchPayload` field is a string or a map of strings, so the branch is a guard against a later field type, not a reachable path today. A package-level `json.Marshal` seam to force it in a test is rejected: it would be the only mutable package global in the repository, and the change already rules out new helpers. `TestLaunchDetachedRunPayloadOnStdin` covers the observable half — the child receives a complete payload.
4. **Wrap with `%w`.** CLI input and plugin-list errors wrap the cause. `ReleaseCheckError` implements `Unwrap` so timeout vs DNS vs TLS stays reachable. Alternative — `%v` — rejected. Callers need `errors.Is` and `errors.As`.
5. **Policy helpers return `error`.** `validateMethodParams`, `swapPolicy`, `movePolicy`, and `assertFocusPolicy` return `nil` when valid. `ValidateHerdrInvocation` stays the exported gate. Alternative — `ok bool` — rejected. The call already converts a string into `error`.
6. **Nil empty slices at three sites.** Empty parse results already error. `ReadDir` failure already returns `nil`. Alternative — keep `make([]string, 0)` for encoder safety — rejected. These slices do not reach JSON.

## Risks / Trade-offs

- [A call site misses a rename] → compile and tests fail. Sweep with exact identifiers, then `go test ./...`.
- [Marshal failure detail leaks into UI wording] → reuse the spawn-failure settle path (`OK: false`, `Detail` from the error).
- [`Path` in package `workflow` collides in a reader’s mind with file paths] → the table requires `Path`. Call sites already qualify `workflow.Path`.
- [Delta spec names Go identifiers] → the `hwf-cli` addition describes launch encoding failure only.

## Migration Plan

Alpha: replace the old names in the same change. No dual export. Rollback is revert of the branch.

## Open Questions

None. Issue 55 names every site.
