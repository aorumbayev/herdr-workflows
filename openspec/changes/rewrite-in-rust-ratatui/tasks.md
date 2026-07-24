## 1. P0 — Skeleton and validation core

- [x] 1.1 Scaffold `rust/` crate: Cargo.toml with the D7 crate set (ratatui, tui-input, serde, serde_json, serde_yml, schemars, clap, anyhow, thiserror, wait-timeout, nix, tiny_http, uuid), clippy config per `.kimi/skills/rust-skills` `lint-` rules, edition 2024
- [x] 1.2 Extract golden error corpus: capture exact `file, step N, key: message` outputs from the TS loader for every failure case in `test/parse-workflow-text.test.ts` and `test/schema.test.ts` into Rust test fixtures
- [x] 1.3 Port config load/merge (`src/config.ts`): repo + `~/.hwf/config.yaml`, agents argv with exactly one `{prompt}` element, sessions map, repo-wins merge; serde `deny_unknown_fields`
- [x] 1.4 Port workflow parse + refine (`src/workflows/parse.ts`, `refine.ts`): strict step schema, one-verb rule, stdin/prompt/wait/wait_for/params/timeout/close_source placement rules, positioned errors matching golden corpus
- [x] 1.5 Port flatten/discover/inputs/recovery (`flatten.ts`, `discover.ts`, `inputs.ts`, `recovery.ts`): run: splicing with cycle detection, repo-shadows-global discovery, dynamic options via `sh -c` with 5s timeout, agents builtin, on_fail rules
- [x] 1.6 Port placeholder substitution (`substitute.ts`, `steps.ts`): placeholder legality bans, `{session}`/`{session_file}` stdin-only, recursive params substitution
- [x] 1.7 Gate: ported parse/refine/flatten/inputs/recovery/config tests green; golden error corpus byte-identical

## 2. P1 — herdr client and runner

- [x] 2.1 Port `herdr/rpc.rs` (`src/adapter/rpc.ts`): UnixStream NDJSON request/response, 10s timeout, HerdrError { code, message }
- [x] 2.2 Port `herdr/cli.rs` (`src/adapter/client.ts`): pane read, agent get (status values), pane wait-output, pane report-metadata, notification show, ui_busy handling
- [x] 2.3 Port invocation context + placeholder values (`src/context.ts`, `adapter/stdin.ts` sanitizer) and session extraction (`src/session.ts`: per-agent sessions argv, Claude JSONL reader)
- [x] 2.4 Port runner dispatch (`src/runner.ts`, `runner/dispatch.ts`, `runner/shell.ts`): sequential steps, sh -c with HWF_INPUT_* env, substituted stdin, 300s timeout with process-group SIGKILL, {last}/{tab}/{prev_tab} threading
- [x] 2.5 Port fire/preflight/agent-wait/runlog (`runner/fire.ts`, `preflight.ts`, `agent-wait.ts`, `src/runlog.ts`): layout.apply flows, wait_for with timeout, wait: done polling (2s poll, grace, 3-strike tolerance, 1800s default), close_source ordering, JSONL run log, recovery run with {error}
- [ ] 2.6 Port `herdr-empirical.test.ts` as a cargo test gated on `HERDR_SOCKET_PATH`; run against live herdr ≥ 0.7.5
- [ ] 2.7 Gate: ported runner/session/context tests green; `hwf run` parity verified on seeded playbooks (review, handoff, worktree) in a real herdr session

## 3. P2 — Picker (ratatui)

- [x] 3.1 Port picker data layer (`src/tui/picker-rows.ts`, `picker-modes.ts`): row building, substring filter, invalid-workflow dimming, mode state machine
- [ ] 3.2 Build ratatui app per design D2: App struct + `impl Widget for &mut App`, List+ListState with reverse-video highlight, tui-input filter line, footer help bar; blocking `ratatui::run` loop
- [ ] 3.3 Confirm gate popup (`picker-run.ts` gating rules) via Clear + Rect::centered
- [ ] 3.4 Input/prompt/run screens: per-input collection, `[i/n] label` progress streaming, `Failed · <error>` display, exit codes 0/1
- [ ] 3.5 Keybindings per picker-ui spec; stdin C0-leak drain equivalent (`adapter/stdin.ts` behavior) if still needed without OpenTUI
- [ ] 3.6 Gate: ported picker unit tests green; manual verification in real herdr popup at 56×14 and at reduced sizes; OpenTUI dependency and `preferOnDiskOpentuiLib` hack deleted from TS tree

## 4. P3 — Web workbench (tiny_http)

- [x] 4.1 Port server (`src/web/server.ts`): 127.0.0.1 bind, port auto-increment from 7317, per-launch token, x-hwf-token + Host/Origin gating, `include_str!` page.html served byte-identical
- [x] 4.2 Port routes (`routes.ts`, `routes-files.ts`): /api/state, /api/workflow GET/PUT/DELETE, /api/parse, /api/format, /api/validate, /api/promote (409 without force), /api/config GET/PUT, /api/runs
- [x] 4.3 Port YAML emitter (`yaml-build.ts`) with its round-trip test corpus unchanged
- [ ] 4.4 Gate: ported web-server tests green (token gating 403s, promote 409, validation parity with CLI); browser smoke test against Rust server

## 5. P4 — Flip and cleanup

- [ ] 5.1 Regenerate `docs/workflow.schema.json` via schemars; snapshot-diff field coverage against Zod-generated schema
- [ ] 5.2 Flip `herdr-plugin.toml`: build steps → `cargo build --release` + copy to `bin/herdr-workflows`; delete `bin/hook.mjs`; verify `scripts/install-keybindings.mjs` and `scripts/install-cli.mjs` unchanged and working
- [ ] 5.3 Run full empirical verification of all five modes in a real herdr session (launch → picker → run, web, init --force in scratch repo)
- [ ] 5.4 Delete TS tree (`src/`, `test/`, `scripts/generate-schema.ts`, bun config/lockfile, verifyx/knip/skott toolchain)
- [ ] 5.5 Update `AGENTS.md`, `docs/guide.md`, `docs/reference.md`, `README.md` for the Rust toolchain (build/test/install:dev equivalents)
- [ ] 5.6 Gate: fresh clone → `cargo build --release` → `herdr plugin link` → all modes work; no bun anywhere in the flow

## Progress notes (apply session, branch `rewrite-in-rust-ratatui`)

Landed beyond the checked boxes (untracked by the numbered tasks):
- `init` mode ported (`rust/src/init.rs`, `rust/src/repo.rs`, seed YAML embedded; `test/init.test.ts` assertions ported to `rust/tests/init.rs`).
- `launch` mode ported in `rust/src/main.rs` (plugin_pane_open + ui_busy → notification).
- CLI arms wired in `rust/src/main.rs`: `run` (full `RunOptions` wiring, progress printing, die semantics), `web`, `init`, `launch`, no-args-TTY → web. Only `picker` is still `not_implemented`.
- Layout note: crate is library-first (`rust/src/lib.rs` declares all modules; `main.rs` is a thin clap shell). New modules must be registered in `lib.rs`, not `main.rs`.

State at handoff: `cargo build` + `cargo clippy --all-targets` clean, `cargo test` 230 passed / 0 failed (includes 64/64 golden error cases byte-identical to the TS loader).

Remaining, in order:
1. Tasks 3.2–3.5: ratatui picker shell over `rust/src/picker/` data layer (`modes.rs` `Picker`/`Screen`/`Action` state machine, `run.rs` `RunExecutor` seam; run execution bridges to `runner::run_workflow` via mpsc on a worker thread). Interface notes are in the picker data-layer module docs. Then wire the `picker` arm in `main.rs` to `picker::run(...)`.
2. Gates 2.6/2.7 (port `test/herdr-empirical.test.ts` gated on `HERDR_SOCKET_PATH`; live `hwf run` parity on seeded playbooks), 3.6 (manual popup verification 56×14 + small sizes), 4.4 (browser smoke test against the Rust server).
3. P4 flip (5.1–5.6). Note for 5.4: TS-side seed assets and `page.html` are already copied into `rust/`; `.plans/` holds the golden-corpus extractor scratch if regeneration is needed.
