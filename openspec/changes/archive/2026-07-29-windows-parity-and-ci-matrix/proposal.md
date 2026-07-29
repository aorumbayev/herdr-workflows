## Why

Windows was a declared plugin target, but reaching parity required a permanent platform-seam surface — named pipes, ACL verification, process-tree termination, executable-suffix and rename-then-place replacement, a PowerShell downloader — while Herdr's own Windows support is preview and both manifest entry points (`prefix+k`, launch action) stay blocked on upstream fix `b499e611` that no Herdr release contains. The audience is developers already running Herdr; for them Windows is served by WSL2, where the Linux behavior applies unchanged.

Native release binaries were the second complexity driver. They buy exactly two things — no Bun prerequisite and a CI-frozen toolchain — at the cost of a four-leg release matrix, draft gating, downloaders, and checksums maintained forever. Runtime dependencies are three packages (~30 MiB with `--production`), so a source install and a binary download cost the same network transfer. Local compile through `herdr plugin install` is the model that has worked since the first release; it stays.

## What Changes

- Declare `platforms = ["linux", "macos"]`. Native Windows installs fail at install time with Herdr's platform error. Windows is supported through WSL2 only, documented in one paragraph. The `b499e611` dependency disappears.
- Keep remote installation as local compile through Herdr: a preflight names the minimum Bun version and fails loud, `bun install --production --frozen-lockfile` pins the three runtime dependencies, `bun build --compile` produces the checkout binary, and Herdr keeps owning registration, replacement, and rollback. Bun ≥ 1.3 becomes the documented prerequisite.
- Replace the Node install scripts with the native hidden `hwf setup` command (POSIX only): CLI symlink with copy fallback under `$XDG_BIN_HOME`/`~/.local/bin`, PATH warning by name, foreign-entry preservation, keybinding validation/backup/atomic replacement/dead-binding cleanup.
- Integrate semantic-release light: conventional-commit versioning within `0.x`, generated notes, `herdr-plugin.toml` as the product-version source, a one-time `v0.1.0` baseline, no npm publication, and no binary assets, checksums, or draft gating.
- Add `hwf update`: checks the latest published release, compares the embedded manifest version, refuses linked development checkouts, leaves the plugin root, and synchronously delegates to `herdr plugin install aorumbayev/herdr-workflows --yes`.
- Show a nonblocking ASCII update indicator in the picker when a newer published version exists.
- Keep the cross-platform correctness fixes this work surfaced: detached-run settlement, transport-failure naming, browser-opener URL fallback (the WSL case), POSIX process-group termination, POSIX credential hardening, LF normalization, and ubuntu+macos unit CI.
- Delete the Windows-native and binary-distribution code: `windows-acl.ts`, named-pipe addressing, `taskkill`, `cmd /c start`, `%APPDATA%` config resolution, `.exe`/`hwf.cmd`/rename-then-place setup, both release downloaders, the native release matrix, checksums, and release smoke tooling.
- Keep workflow grammar, templates, and loader behavior unchanged.

## Capabilities

### New Capabilities
- `plugin-installation`: Versioned releases, Bun-compiled remote installation, native setup, CLI/keybinding installation, repeat installation, and Herdr-owned update contract.

### Modified Capabilities
- `herdr-primitives`: Transport failures name the resolved socket address and are distinguishable from version, protocol, and authoring errors.
- `hwf-cli`: The public command surface gains `update`; browser control surfaces the URL when no opener starts; detached self-launch settles reliably.
- `workflow-grammar`: Timeout and capture-cap termination stop the launched command and its descendants.
- `picker-workbench-actions`: Endpoint credentials verify the resolved state directory before writing, and the picker surfaces newer published plugin versions without blocking startup.

## Impact

- `herdr-plugin.toml` platforms and build commands; a small Bun-version preflight script; deletion of `scripts/download-release.sh`, `scripts/download-release.ps1`, `scripts/release-assets.ts`, `scripts/write-checksums.ts`, `scripts/smoke-release-binary.ts`, `scripts/release-preflight.ts`, `src/smoke-opentui.ts`, and `src/web/windows-acl.ts`.
- Windows branches removed from `src/herdr.ts`, `src/run/steps/shell.ts`, `src/web/browser.ts`, `src/web/credential-store.ts`, `src/setup/*`; `ownership.ts` shrinks to symlink-into-checkout recognition.
- `.github/workflows/release.yml` loses the native matrix; `verify.yml` loses the Windows leg and keeps ubuntu+macos.
- Docs: Bun prerequisite line, WSL2 paragraph replacing the Windows checklist, `hwf update` documentation.
- Existing users pick up the new manifest on their next `herdr plugin install`; one final manual reinstall still delivers `hwf update` to installs that predate it.
