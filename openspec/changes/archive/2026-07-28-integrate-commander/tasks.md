## 1. Dependency

- [x] 1.1 Add direct `commander@15.0.0` dependency and refresh the lockfile with Bun

## 2. CLI rewrite

- [x] 2.1 Build the Commander program in `src/cli.ts` with `run`, `init`, `workflow import`, `launch`, `picker`, and `web`, plus root no-args TTY to web and non-TTY usage failure
- [x] 2.2 Move repeatable `--input` and `--port` validation into Commander option processors with `InvalidArgumentError`. Constrain import `--to` with an `Option` choice. Keep `--launch-payload`, init/import consent flags, init `--global`, `--no-open`, and equals-form parsing
- [x] 2.3 Remove `exitOverride`, suppressed output, stripped error prefixes, disabled help commands, and custom parse-error reconstruction. Use Commander-native errors, suggestions, `-h` / `--help`, and `help [command]`
- [x] 2.4 Delete hand-rolled `parseArgs` and any leftover parallel dispatch helpers. Do not add command factories, duplicate command models, or one-use interfaces
- [x] 2.5 Route the no-subcommand case through Commander. Start web only for a TTY. Use generated error help for non-TTY invocation without starting the server
- [x] 2.6 Import the plugin version from `herdr-plugin.toml`, expose Commander `-V` / `--version`, and label workflow format `v1alpha1` separately in generated help

## 3. Tests

- [x] 3.1 Update `test/cli.test.ts` for Commander-native help, unknown-command suggestions, option and required-argument errors, repeated `--input`, `--input=equals` syntax, invalid `--input`, constrained `--to`, `--no-open` / bad `--port`, non-TTY no-args help failure, and protocol preflight ordering before missing-input failure
- [x] 3.2 Preserve `test/setup.ts` isolation. Use fake sockets and mocks only. Never contact live herdr or hwf
- [x] 3.3 Confirm detached self-launch argv coverage in existing `test/run-launch.test.ts` still matches `run <name> --launch-payload` and `web <route>`
- [x] 3.4 Cover plugin version output and the separate workflow-format help line in process-level CLI tests

## 4. Docs and gates

- [x] 4.1 Update README and the guide for native Commander help and version commands. Confirm tracked skills need no changes when their command semantics remain accurate
- [x] 4.2 Run `bun test ./test`, `CI=1 npm run verify`, `bun run docs:build`, `openspec validate --all --strict`, and `git diff --check`. Fix all failures
- [x] 4.3 Sync the revised `hwf-cli` delta into `openspec/specs/hwf-cli/spec.md` and archive `integrate-commander` on this feature branch so the archive and main specs remain in the final patch
