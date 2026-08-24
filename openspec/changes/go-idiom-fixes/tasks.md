## 1. Rename sweep (stutter + initialism)

- [x] 1.1 Rename the 13 exported identifiers per the issue 55 from/to table in their defining packages (`workflow`, `history`, `config`, `transcript`, `update`, `cli`)
- [x] 1.2 Rename unexported `herdrCli` to `herdrCLI` in `internal/host/cli.go` and its call sites
- [x] 1.3 Update every intra-module call site and test that names the old identifiers, including `scripts/build-examples`

## 2. Error handling (groups 3–6)

- [x] 2.1 Delete unused `major` in `internal/update/semver.go` `parseParts`. Drop unused `index`/`total` from `RunsFooter` and update callers/tests
- [x] 2.2 Check `json.Marshal` in `LaunchDetachedRun`. Settle the handle on failure without writing an empty payload. Cover with a test
- [x] 2.3 Wrap with `%w` in `internal/cli/run.go` and `internal/cli/update.go`. Give `ReleaseCheckError` an `Unwrap` and wrap transport causes in `internal/update/check.go`
- [x] 2.4 Change `validateMethodParams`, `swapPolicy`, `movePolicy`, and `assertFocusPolicy` to return `error`. Keep `ValidateHerdrInvocation` as the exported gate. Update tests

## 3. Empty slices (group 7)

- [x] 3.1 Switch `make([]string, 0)` to `var x []string` in `ParseVerdictTokens`, `ParseDynamicChoiceStdout`, and `yamlWorkflowNames`
