## Why

The picker popup's launch latency requires the `preferOnDiskOpentuiLib` hack (`src/cli.ts`), OpenTUI native-lib loading (`OPENTUI_LIBC`, `OTUI_ASSET_ROOT`) is the flakiest part of the product, and the Bun-compiled binary is ~50MB with a Bun toolchain required at install time. A single small Rust binary eliminates all three.

## What Changes

- Reimplement the full plugin — CLI (`run`/`picker`/`web`/`init`/`launch`), workflow engine, herdr adapter, picker TUI, and web workbench — as one Rust binary built with cargo, served from the same `bin/herdr-workflows` path. **BREAKING**: Bun is no longer a build or runtime dependency; `herdr-plugin.toml` build steps change to cargo.
- Replace the OpenTUI picker with a ratatui picker preserving current behavior (modes, substring filter, confirm gate, progress stream, exit codes). **BREAKING**: terminal-palette detection and WCAG-AA contrast computation are dropped; selection uses terminal default colors with reverse video.
- Replace `Bun.serve` web workbench with an embedded single-threaded HTTP server; routes, token/origin gating, and `page.html` payload are unchanged.
- Replace Zod validation with serde structs plus hand-rolled cross-field validators; positioned error message format (`file, step N, key: message`) is preserved exactly.
- Regenerate `docs/workflow.schema.json` from Rust types (`schemars`) instead of Zod.
- Keep `scripts/install-keybindings.mjs` and `scripts/install-cli.mjs` as-is (they run in the herdr plugin-install environment).
- Port the test suite's assertions to Rust; delete the TypeScript tree after the manifest flips.

## Capabilities

### New Capabilities
- `rust-runtime`: single self-contained Rust binary as the sole runtime; cargo build via manifest; no Bun/OpenTUI dependency; fast picker startup.
- `picker-ui`: picker popup behavior — list/input/prompt/run/confirm modes, substring filter, confirm gate for repo-owned and dynamic-options workflows, progress streaming, keybindings, theme via terminal defaults + reverse video.

### Modified Capabilities
<!-- None: workflow-dsl, web-workbench, and seeded-playbooks requirements are behavior-preserving ports; only implementation language changes. -->

## Impact

- **Code**: entire `src/` tree (~4,100 LOC TS) replaced by a new `rust/` crate; `test/` (~2,800 LOC) ported as cargo tests; TS tree deleted at completion.
- **Build**: `herdr-plugin.toml` build steps become `cargo build --release`; `bin/hook.mjs` shim deleted.
- **Dependencies**: OpenTUI, Zod, and all Bun built-ins removed; Rust crates: ratatui, tui-input, serde/serde_json/serde_yml, clap, anyhow/thiserror, schemars, wait-timeout, nix, tiny_http, uuid. No async runtime.
- **External contracts preserved**: herdr socket JSON-RPC protocol, `herdr` CLI subprocess usage, `HERDR_*`/`HWF_INPUT_*` env vars, config/workflow YAML schemas, positioned error strings, web API routes and token gating, `docs/workflow.schema.json` content, seed workflow YAML.
- **Docs**: `docs/guide.md`/`reference.md` install and development sections updated; `AGENTS.md` rewritten for the Rust toolchain.
