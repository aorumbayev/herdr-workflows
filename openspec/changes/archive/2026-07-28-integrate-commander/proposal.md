## Why

`src/cli.ts` hand-rolls argv parsing and command dispatch. That works for six commands but duplicates option, help, and error wiring. Commander is a mature zero-dep parser that maps to this surface. Adopt it now while the command set is still small.

## What Changes

- Add `commander@15` as a direct runtime dependency and refresh the lockfile.
- Replace hand-rolled `parseArgs` and `main()` dispatch in `src/cli.ts` with a Commander program that owns parse and dispatch for `run`, `init`, `workflow import`, `launch`, `picker`, and `web`.
- Preserve product contracts that do not depend on parser wording: TTY no-args opens web, non-TTY no-args fails without starting web, repeatable `--input name=value`, `--launch-payload` stdin flow, `--flag=value` forms, import and init consent flags, web route and `--port` / `--no-open`, lazy picker import, Herdr protocol preflight ordering, exit codes, and detached self-launch argv.
- Use Commander-native errors, suggestions, generated help, option argument validation, and constrained choices. Remove compatibility shims for old usage and error text.
- Expose the plugin manifest version through Commander `-V` / `--version`. Label `v1alpha1` separately as the workflow format in generated help.
- Delete the exported `parseArgs` helper. Nothing outside `cli.ts` imports it.
- Add behavior-focused CLI tests for native help, version, and errors, unknown commands and options, required args, repeated inputs, equals syntax, aliases and no-arg behavior where feasible, and protocol preflight ordering.
- Update README or docs only when a user-visible CLI contract changes.

## Capabilities

### New Capabilities
- `hwf-cli`: Public `hwf` / `herdr-workflows` command surface. Covers subcommands, options, default no-args behavior, launch payload flow, protocol preflight ordering, and exit semantics that the Commander rewrite must preserve.

### Modified Capabilities
- (none)

## Impact

- `package.json` and lockfile gain a direct `commander` dependency.
- `src/cli.ts` is the sole implementation owner of the rewrite.
- `test/cli.test.ts` gains coverage for preserved contracts.
- Compiled `bin/herdr-workflows` via `bun build --compile` must keep working.
- Detached self-launch in `src/tui/run-launch.ts` keeps the same argv shape (`run <name> --launch-payload` and `web <route>`).
- No workflow YAML, loader, runner, or Herdr socket contract changes.
