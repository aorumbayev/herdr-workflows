## Context

herdr-workflows is a herdr plugin: ~4,100 LOC Bun + TypeScript ESM in `src/`, plus ~2,800 LOC of `bun test` tests. Five entry modes (`run`, `picker`, `web`, `init`, `launch`) ship as one `bun build --compile` binary at `bin/herdr-workflows`, invoked by `herdr-plugin.toml` (picker popup 56×14). The picker uses OpenTUI (native lib, `OPENTUI_LIBC`/`OTUI_ASSET_ROOT` env, `preferOnDiskOpentuiLib` launch-latency hack); validation is Zod; YAML is `Bun.YAML`; the web workbench is `Bun.serve`. Two full codebase maps (module inventory + ratatui 0.30 pattern survey from `references/ratatui`) were produced during exploration and ground every decision below.

Constraints carried over: herdr owns panes/UI; the plugin only loads and runs steps. The herdr socket JSON-RPC protocol, `herdr` CLI subprocess contract, `HERDR_*`/`HWF_INPUT_*` env vars, YAML schemas, and positioned error strings are external contracts that must not drift.

## Goals / Non-Goals

**Goals:**
- One Rust binary at `bin/herdr-workflows` covering all five entry modes; no Bun, no OpenTUI, no async runtime.
- Picker launch in single-digit ms; binary an order of magnitude smaller than the Bun-compiled one.
- Behavioral parity for `run`/`web`/`init`/`launch`: same protocols, env vars, error strings, routes, seed YAML.
- Test parity: existing test assertions ported to cargo tests; `herdr-empirical` equivalent still runs against live herdr when `HERDR_SOCKET_PATH` is set.

**Non-Goals:**
- No DSL changes, no new workflow features, no spec-level behavior changes to `workflow-dsl` / `web-workbench` / `seeded-playbooks`.
- No terminal-palette detection or WCAG-AA contrast computation in the picker (dropped deliberately).
- No rewrite of `scripts/install-keybindings.mjs` / `scripts/install-cli.mjs` (they run in the herdr plugin-install environment with bun available).
- No async (tokio) anywhere: picker is a blocking loop, web is single-threaded localhost, runner is sequential.
- No Windows support (unchanged from current product constraints).

## Decisions

### D1: Single binary crate, not a workspace
One crate at `rust/` with `src/{main,config}.rs` and modules `workflow/`, `runner/`, `herdr/`, `picker/`, `web/`. The app is ~4k LOC; a workspace adds ceremony with zero payoff (YAGNI). Layout mirrors the TS module boundaries so parity review is file-to-file.

### D2: ratatui 0.30 + crossterm, blocking loop, `tui-input`
Copy the `examples/apps/todo-list` skeleton: `App` struct, `impl Widget for &mut App`, `List`+`ListState` with highlight style, footer help `Paragraph`; `Clear` + `Rect::centered` for the confirm/action popup (popup example); `tui-input` for the filter/input lines (official user-input example points to it for unicode-safe cursor math). `ratatui::run(|terminal| ...)` gives init/restore + panic-hook teardown for free. No tokio/EventStream, no mouse capture, no inline viewport — none are needed for a list picker. Alternatives considered: porting OpenTUI parity including OSC palette queries (rejected: no ratatui equivalent, high cost, low value — theme becomes terminal defaults + reverse-video selection); hand-rolling input (rejected: `tui-input` is smaller than the bug surface).

### D3: `tiny_http` for the web workbench
Single-threaded HTTP/1.1 server bound to `127.0.0.1`, port auto-increment from 7317, per-launch token (`x-hwf-token` header, `?token=` for `/`), Host/Origin allowlist — all trivially expressible on `tiny_http`. `page.html` (34KB) embedded via `include_str!` and served byte-identical. Alternative considered: axum (rejected: pulls tokio + tower for a localhost server with ~10 JSON routes; violates the no-async-runtime goal).

### D4: serde + hand-rolled validators replace Zod
`serde_yml` (maintained fork; `serde_yaml` is deprecated) with `#[serde(deny_unknown_fields)]` for strict-object semantics. Cross-field rules from `refine.ts` (one verb per step, stdin/prompt/wait/close_source/params placement, timeout requires wait, run takes no modifiers) become a hand-rolled validation pass over the deserialized AST, exactly as today (loader, not schema). Positioned errors (`file, step N, key: message`) are reconstructed by validating against the raw YAML span info, not serde's path tracking (too weak) — this is the highest-risk fidelity item and gets golden tests first. `schemars` derives replace `zod-to-json-schema` for `docs/workflow.schema.json`, snapshot-diffed against the current file.

### D5: herdr adapter as a thin client module
`herdr/rpc.rs`: `std::os::unix::net::UnixStream`, write one NDJSON line, read one line, 10s timeout, error unwrap into a `HerdrError { code, message }` (thiserror). `herdr/cli.rs`: `std::process::Command` wrappers for `pane read`, `agent get`, `pane wait-output`, `pane report-metadata`, `notification show`. No abstraction layer beyond what call sites need (YAGNI); the module boundary exists so runner tests can fake it via a trait at the runner/herdr seam only.

### D6: Shell steps via `wait-timeout` + `nix` process-group kill
`sh -c` with piped stdin/stdout/stderr, `HWF_INPUT_*` env, 300s timeout; on timeout `nix::kill(Pid::from_raw(-pid), SIGKILL)` on the process group (matches current `detached` + negative-pid behavior). Windows branch is dropped per non-goals.

### D7: Minimal crate set, no speculative deps
`ratatui`, `tui-input`, `serde`, `serde_json`, `serde_yml`, `schemars`, `clap` (derive; replaces the hand-rolled parser with less code), `anyhow` (CLI top level) + `thiserror` (domain errors: positioned load errors, HerdrError), `wait-timeout`, `nix`, `tiny_http`, `uuid` (web token, run ids). Nothing else without a demonstrated call site.

### D8: rust-skills as the implementation standard
All Rust code in this change follows `.kimi/skills/rust-skills` (265 rules, index at `SKILL.md`, progressive disclosure via `rules/<prefix>-*.md`). Relevant categories for this codebase: `err-` (thiserror/anyhow split), `own-` (borrow over clone), `serde-` (validate-on-deserialize), `test-` (golden/snapshot tests), `lint-` (clippy config in CI), `anti-` (no `.unwrap()` outside tests/main). Implementers load the category files relevant to the module in front of them, not the whole set.

### D9: Shadow development, single manifest flip
Rust develops in `rust/` while the TS binary keeps serving. `herdr-plugin.toml` flips (build steps → `cargo build --release` + copy to `bin/herdr-workflows`, delete `bin/hook.mjs`) only after all modes pass the ported test suite plus a live empirical run. No hybrid binary, no per-mode migration. Rollback = revert the manifest commit and rebuild from TS (kept until flip is verified in a real herdr session).

## Risks / Trade-offs

- **Positioned YAML error parity** — serde path tracking is too weak for `file, step N, key: msg` → Build the validator over the parsed document with manual position threading; pin exact current messages as golden tests (P0) before porting any logic; snapshot the full error corpus from `test/parse-workflow-text.test.ts` and `test/schema.test.ts`.
- **herdr protocol drift** — reimplemented socket/CLI client could diverge silently → Port `herdr-empirical.test.ts` early (P1) and run it against live herdr ≥ 0.7.5; it already asserts `layout.apply` id shapes, `agent.list`, pane-read ESC handling, popup size clamping.
- **Test-port drag** — 1,003 LOC of runner tests are mock-heavy → Port assertions, not mock shapes; single trait seam at runner/herdr boundary; delete tests whose only value was mocking Bun APIs.
- **Picker visual regression** — theme simplification changes appearance → Accepted in proposal (BREAKING, user-approved); verify manually in real herdr popup at 56×14 and at small sizes (ratatui widgets tolerate tiny buffers but the picker layout must degrade gracefully).
- **YAML emitter round-trip** (`web/yaml-build.ts` byte-exact scalar rules) → Port with its existing round-trip test corpus unchanged.
- **`bun test` behaviors with no Rust equivalent** (Bun.YAML leniency edge cases) → Characterization tests on the TS side first for any YAML construct the suite doesn't already cover (anchors, multiline scalars in `shell:`).
- **Single big-bang flip** → Mitigated by shadow dir + empirical gate; rollback is a manifest revert.

## Migration Plan

1. **P0 — skeleton + validation core**: cargo crate, clap CLI shape, config load/merge, workflow parse/refine/flatten/inputs/recovery, positioned errors. Gate: golden error corpus + parse tests green.
2. **P1 — herdr client + runner**: rpc/cli adapters, dispatch (shell/open/agent/herdr), preflight, agent-wait, runlog, session extraction. Gate: ported runner tests + `herdr-empirical` green against live herdr; `hwf run` parity on seeded playbooks.
3. **P2 — picker (ratatui)**: modes, filter, confirm gate, progress stream, keybindings, theme. Gate: picker unit tests + manual popup verification; OpenTUI + latency hack deleted.
4. **P3 — web (tiny_http)**: routes, token/origin gating, promote, config, YAML emitter, `include_str!` page. Gate: ported web-server tests (token gating, 409 promote, validation parity).
5. **P4 — flip**: manifest build steps → cargo, schema regen via schemars (snapshot-diff), keybindings/CLI install scripts re-pointed if needed, TS `src/`+`test/` deleted, `AGENTS.md`/docs updated, `bun run install:dev` replaced.

Rollback: revert P4 manifest commit; TS tree is deleted only after the flipped binary survives a real herdr session.

## Open Questions

- Exact clap subcommand/flag surface for `init` TTY prompts (dialoguer? plain stdin readline?) — decide at P0; plain stdin is the YAGNI default since current prompts are y/N only.
- Whether `docs/workflow.schema.json` generation becomes a `cargo xtask` or a `--emit-schema` hidden CLI flag — decide at P4; either is fine, pick the smaller.
