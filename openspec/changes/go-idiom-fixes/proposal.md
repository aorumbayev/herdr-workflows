## Why

Issue 54 audited `internal/` against Effective Go, CodeReviewComments, and Go 1.13 error wrapping. About 20 sites stutter the package name, flatten errors, silence blanks, return in-band empty strings, or allocate empty slices. Issue 55 adopts every group as one alpha change because the names never appear in YAML, CLI argv, or main specs.

## What Changes

- **BREAKING** (intra-module only): rename the 13 exported identifiers in the issue 55 from/to table, plus unexported `herdrCli` to `herdrCLI`. Call sites and tests move with the names. No aliases and no migration.
- Check `json.Marshal` in `LaunchDetachedRun` and settle the handle on failure instead of writing an empty launch payload.
- Wrap CLI and release-check errors with `%w` so callers can use `errors.Is` and `errors.As`.
- Return `error` from herdr method policy helpers instead of an empty-string sentinel.
- Delete unused `major` in semver parse and unused `RunsFooter` position parameters.
- Declare three empty string slices with `var x []string` instead of `make([]string, 0)`.
- Leave `WorkflowAction` and `cliResult` unchanged. Do not change JSON nil-vs-empty except at the three listed slice sites.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hwf-cli`: add that a detached launch whose payload encoding fails MUST settle the awaited handle as failure and MUST NOT write an empty payload to the child. Rename, wrap, and empty-slice sites stay out of main specs.

## Impact

- **Code:** packages under `internal/workflow`, `internal/history`, `internal/config`, `internal/transcript`, `internal/update`, `internal/cli`, `internal/host`, `internal/engine`, `internal/runsbrowser`, plus intra-module call sites and `scripts/build-examples`.
- **Tests:** rename call sites. Update tests that cover marshal failure, wrapped CLI errors, `ReleaseCheckError` unwrap, and method policy helpers.
- **Gates:** `go tool verify` after the three tasks. `openspec validate --all --strict`.
- **Dependencies:** none added or removed.
