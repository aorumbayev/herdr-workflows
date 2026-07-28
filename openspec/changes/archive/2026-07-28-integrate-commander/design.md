## Context

`src/cli.ts` owns the `hwf` / `herdr-workflows` entrypoint. Today it exports a small `parseArgs` helper and dispatches six commands by hand. Runtime deps are only `zod` and `@opentui/core`. Commander 15 is already in the lockfile via `@makerx/verify` but is not a direct dependency of the plugin binary.

Detached picker and workbench launches rebuild argv through `src/tui/run-launch.ts` as `run <name> --launch-payload` (payload on stdin) and `web <route>`. Those argv shapes are part of the preserved contract.

Constraints: Bun ESM and `bun build --compile`. Lazy `import("./tui/picker")` for opentui asset cost. Domain failures still use `die()`, while argv failures belong to Commander. Process-spawn tests in `test/cli.test.ts` use `test/setup.ts` to quarantine live `herdr` / `hwf`. YAGNI and knip unused-code.

## Goals / Non-Goals

**Goals:**
- Declare the public CLI with Commander and delete hand-rolled argv parsing.
- Preserve product behavior used by docs, plugins, and detached launch. Prefer Commander-native argv errors and help over legacy text compatibility.
- Keep command handlers as ordinary async functions. Commander only owns parse, dispatch, and help.
- Pin `commander@15.0.0` as a direct dependency.
- Cover unknown command and option paths, required args, repeated inputs, equals syntax, aliases, no-arg TTY behavior, and Herdr protocol preflight ordering with process-level tests that never contact live herdr or hwf.

**Non-Goals:**
- Reworking workflow load or run semantics, picker UI, or the web server.
- Introducing Clipanion, Citty, Gunshi, Typanion, or Zod-based argv schemas.
- Plugin-style command discovery, command factories, duplicate command models, or one-use interfaces.
- Changing bin names, keybindings, or `herdr-plugin.toml` entrypoints.
- Adding speculative flags such as `--prompt` that the current CLI does not expose.

## Decisions

1. **Commander 15 as the only CLI framework**
   - Rationale: mature, zero nested runtime deps, maps cleanly to the current command tree. Clipanion and Citty lose on ceremony, maturity, or YAGNI for this surface.
   - Alternatives considered: keep hand-rolled. Citty (smaller but 0.x). Clipanion (Typanion plus class overhead).

2. **Single program in `src/cli.ts`, no command modules**
   - Rationale: six commands do not justify a `commands/` tree. Knip wants reachability from the CLI graph. One file per concept already holds here.
   - Alternatives considered: one file per subcommand (over-split). Factories or command registries (speculative wrappers).

3. **Commander handles the no-subcommand path**
   - Rationale: keep the program free of a root `.action()`. Stock Commander then owns empty-argv error help, the implicit `help [command]`, and unknown-command suggestions. A root action would disable the implicit help command and turn unknown tokens into excess-argument errors.
   - Bare TTY invocation appends `web` to the user argv and parses with `{ from: "user" }` so web still starts only when stdin and stdout are TTYs. Non-TTY bare invocation stays empty and gets generated error help without binding a port.

4. **Commander validates and converts option arguments**
   - Rationale: custom option processors validate repeatable `--input` values and `--port` during parsing with `InvalidArgumentError`. An `Option` choice constrains import `--to` to `repo` or `global`. This gives generated help and errors one source of truth.
   - `--launch-payload` stays a boolean option. `--no-open` uses Commander negatable-option behavior.
   - Keep `--input` as repeated `--input name=value` collect, not variadic `--input <vals...>` (would change argv grouping).

5. **Use Commander-native errors and help**
   - Rationale: Commander owns argv parsing, so it also owns unknown-command suggestions, option errors, required-argument errors, generated usage, `-h` / `--help`, and `help [command]`.
   - Do not suppress `writeErr`, strip the `error:` prefix, intercept `CommanderError`, disable help commands, or reconstruct parse failures through `die()`.

6. **Lazy picker import stays inside the `picker` action**
   - Rationale: compile and opentui hot-path constraint is unchanged. Commander must not eagerly import the TUI module at program construction.

7. **Protocol preflight stays first in `run`, `picker`, and `launch` handlers**
   - Rationale: Commander validates argv before dispatch. Once parsing succeeds, `ensureHerdrProtocol()` rejects protocol and version mismatches before launch-payload reads, workflow input resolution, execution, or picker loading. Action wrappers must not reorder that call.

8. **Handlers take Commander option bags. No exported `parseArgs`**
   - Rationale: destructive update. Nothing imports `parseArgs` outside `cli.ts`.

9. **Additive `-y` short alias for `--yes`**
   - Rationale: init and import already treat `--yes` as consent. Commander short `-y` is additive and matches common CLI form. Current `--y` long-option quirk is not a documented contract.

10. **Plugin version and workflow format stay distinct**
    - Rationale: `herdr-plugin.toml` is the installed plugin version source, while `v1alpha1` identifies workflow YAML compatibility. Import the manifest through Bun, pass its version to Commander `.version()`, and show the workflow format as separate help text.
    - Do not expose `package.json` version `0.0.0-development` as the installed plugin version.

## Risks / Trade-offs

- **[Intentional change] Commander error and help text differs from old `usage:` strings** → Update tests and specs to assert behavior and useful native diagnostics instead of retaining the old parser's wording.
- **[Risk] `--no-open` negatable semantics surprise** → Declare `--no-open` so default open stays true. Assert in a focused CLI test.
- **[Risk] Compile binary size or import cost** → Commander is small and sync. Picker remains a dynamic import.
- **[Risk] Empty `HERDR_WORKFLOWS_REPO_ROOT` treated as set** → Preserve falsy `||` handling exactly as today in handlers.
- **[Risk] Detached launch argv drift** → Keep `buildRunArgs` / `selfRunArgv` / `selfWebArgv` unchanged. Do not rename `--launch-payload`.
- **[Trade-off] Auto-generated help and the `help` command add output and one generated command** → Accept them as the standard Commander interface.
- **[Risk] Manifest and CLI version drift** → Import `herdr-plugin.toml` directly so the compiled CLI and plugin registry use one version value.

## Migration Plan

1. Add `commander@15.0.0` to `dependencies` and refresh the lockfile.
2. Rewrite `src/cli.ts` program and handlers. Delete `parseArgs`.
3. Extend `test/cli.test.ts` for the contracts above. Keep `test/setup.ts` quarantine.
4. Run `bun test ./test`, `CI=1 npm run verify`, `bun run docs:build`, `openspec validate --all --strict`, and `git diff --check`.
5. Sync the `hwf-cli` delta into main specs. Archive the change on this feature branch.
6. No user-data migration. Rollback is revert.

## Open Questions

- None blocking.
