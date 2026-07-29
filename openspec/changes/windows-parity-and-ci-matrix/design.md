## Context

`herdr-plugin.toml` originally declared Linux, macOS, and Windows. A Windows 11 ARM64 investigation with Bun 1.3.14 and an emulated x86_64 Herdr 0.7.5 preview found the workflow sequencing core works there, but every platform boundary fails: named-pipe addressing, browser opening, process-tree termination, detached completion, credential permissions, executable suffixes, relative plugin command resolution, keybinding paths, fixtures, and line endings. Reaching parity required all of: a PowerShell downloader, Windows ACL verification, `taskkill` process trees, `.exe`/`hwf.cmd` PATH commands with rename-then-place replacement and stale-image sweeps, `%APPDATA%` config resolution — plus a hard dependency on upstream Herdr commit `b499e611` (relative plugin command resolution), which no published Herdr release contains. Herdr's own Windows support is preview.

That work was implemented and measured before this change was rescoped. The measurements stand as the record of what native Windows costs; the decision below is that the cost is not worth paying for this audience.

The second complexity driver was native release binaries. Measured facts: `bun build --compile` output is 73 MiB (63 MiB is the embedded Bun runtime — an irreducible floor); runtime dependencies are three packages, so `bun install --production --frozen-lockfile` transfers roughly the same ~30 MiB as a compressed binary asset. Binaries therefore buy exactly two things — no Bun prerequisite, and a CI-frozen toolchain — at the recurring cost of a four-leg release matrix, draft-release gating, two downloaders, checksum plumbing, and release smoke tooling.

Confirmed working cross-platform and retained regardless of the rescope: detached-run settlement fixes, transport-failure naming, browser-opener URL fallback, POSIX process-group termination, POSIX credential hardening, LF normalization, native setup, `hwf update`, and the picker update indicator.

Constraints from `AGENTS.md`: no per-OS authoring syntax beyond `{{context.platform}}` and `when:`, caps stay in `src/limits.ts` and never truncate, no narrating comments, new modules must be reachable from the CLI graph or knip fails, and `bun run schema` / `bun run examples` outputs are compared byte for byte.

## Goals / Non-Goals

**Goals:**
- Make the declared product surface and complete test suite reliable on Linux and macOS, with Windows served through WSL2 using the Linux behavior unchanged.
- Keep remote installation as local compile through `herdr plugin install`, with Bun as the one documented prerequisite and a preflight that fails loud on a missing or old Bun.
- Version releases with semantic-release (tags, notes, manifest bump) without npm publication or binary assets.
- Provide `hwf update` and a nonblocking picker indication for newer published releases.
- Keep Herdr as the sole owner of the managed checkout, registry entry, and replacement transaction.

**Non-Goals:**
- No native Windows support of any kind; no Windows CI leg, downloader, ACL handling, or executable-suffix logic.
- No native release binaries, checksums, or download-based installation. Re-add only on evidence: repeated install failures traceable to Bun version variance, users without a JS toolchain pushing back, or a standalone (non-Herdr) distribution need.
- No workflow grammar, template, loader, or per-OS authoring expansion.
- No automatic update installation, background daemon, release channels, npm package, Homebrew, or Nix.

## Decisions

### 1. WSL-only Windows, no native binaries

Native Windows parity and binary distribution were both implemented on this branch and both are dropped. The audience is developers already running Herdr — terminal-native, able to install Bun in one command and run WSL2. Native Windows support carried a permanent platform-seam surface plus an open-ended wait on unreleased upstream fix `b499e611`; binaries carried permanent release engineering while being a network-transfer wash against a `--production` source install. Both fail the insurance test: fixed recurring cost, payout proportional to an audience size that does not exist yet. Deleted code stays in git history; re-adding either is a revert plus the then-current gates.

### 2. Local compile through Herdr, hardened

Remote `herdr plugin install` keeps cloning and building the checkout. The manifest build becomes: Bun-version preflight (names the minimum, fails before any install work), `bun install --production --frozen-lockfile` (three runtime dependencies, ~30 MiB, exact versions), `bun build --compile`, then native `hwf setup`. Frozen lockfile pins dependencies exactly; compiler variance is accepted and surfaced by the preflight's minimum rather than debugged from cryptic compile errors. Linked development checkouts keep `bun run install:dev`; Herdr does not run manifest build commands for `plugin link`.

### 3. Semantic-release light

Semantic-release runs on `main` with conventional commit analysis, generated notes, the `breaking: true` → minor rule while the major is zero, a prepare step updating `herdr-plugin.toml`, a release commit with a loop-skip marker, and a `v<version>` tag — publishing a plain GitHub Release with notes only. No draft gating, no assets, no checksums: with nothing to attach, a release is complete the moment it exists. The `v0.1.0` baseline still lands first so historical `feat!` commits cannot force `1.0.0`. `package.json` stays `0.0.0-development`.

### 4. Native setup replaces the Node install scripts

A hidden `hwf setup` command owns CLI and keybinding setup, POSIX-only: `$XDG_BIN_HOME` or `~/.local/bin`, symlinks with copy fallback, PATH warning by name, foreign-entry preservation. Ownership recognition reduces to "symlink resolves into the plugin checkout" plus the recorded copy marker — no rename-then-place, no stale-image sweeps. Keybinding setup prefers `HERDR_CONFIG_PATH`, otherwise the XDG path, and keeps temporary validation, backup, atomic rename, idempotency, and dead-binding cleanup.

### 5. `hwf update` synchronously delegates to Herdr

`hwf update` fetches the latest published GitHub Release, validates a strict `v0.x.y` tag, and compares it with the embedded manifest version. Equal or older prints `already up to date`. Newer versions proceed only for Herdr-managed GitHub installs; linked checkouts are refused with `bun run install:dev` guidance; unregistered binaries are told to install through Herdr. The command leaves `HERDR_PLUGIN_ROOT` before synchronously invoking `herdr plugin install --yes` and forwards output and exit status. POSIX rename semantics make the old close-the-picker precondition unnecessary; the picker still moves its CWD to the invocation repository before mounting, which is correct behavior regardless.

### 6. Update checks are nonblocking presentation

Picker startup fires one best-effort latest-release request concurrently with loading, never awaits it before mount, and ignores every failure mode. A newer valid version adds the ASCII `[run hwf update]` indicator to the filter row. No persistent cache until a rate-limit problem is observed.

### 7. Retained cross-platform correctness fixes

Detached runs keep their handle referenced while observed, settle the awaited outcome as detached on detach, then unref. Transport failures name the resolved socket address, distinct from version, protocol, and authoring errors. Browser launch tries `open`/`xdg-open` and surfaces the URL when no opener starts — the common WSL case. Timeout and capture overflow terminate the POSIX process group. Endpoint credentials keep user-only modes and refuse environment-redirected state directories that grant broader access.

### 8. Verification stays platform-representative for the supported set

PR CI runs `bun test ./test` with explicit timeouts and `fail-fast: false` on Ubuntu and macOS. Static `npm run verify` stays on Linux. `.gitattributes` keeps tracked text LF-stable.

## Risks / Trade-offs

- **User-side compile couples releases to user Bun versions** → frozen lockfile pins dependencies; the preflight names the tested minimum; CI tests the current Bun. Tripwire for reintroducing binaries: repeated install failures traceable to compiler variance.
- **Bun prerequisite filters out toolchain-less users** → audience is Herdr developers; the prerequisite is one documented command. Tripwire: real pushback from users without a JS toolchain.
- **A release commit must update `main`** → GitHub Actions token with explicit contents permission, loop-skip marker, tag/manifest equality check.
- **GitHub checks add picker startup traffic** → nonblocking and best-effort; cache only with rate-limit evidence.
- **Native Windows users cannot install at all** → intentional; Herdr's platform error at install preview is the correct failure, and the WSL2 paragraph is the documented path. Herdr-on-native-Windows cannot pair with hwf-in-WSL (separate servers, separate sockets) — documented plainly.

## Migration Plan

1. Prune the branch: delete Windows-native and binary-distribution code, tests, and CI legs listed in tasks sections 2 and 3.
2. Rewrite `herdr-plugin.toml` to the linux+macos source-compile shape with the Bun preflight.
3. De-asset the semantic-release configuration; keep tags, notes, and the manifest bump.
4. After merge, tag the pre-change `main` commit as `v0.1.0`, push that baseline, then manually dispatch the first automated release. No upstream Herdr wait remains.
5. Docs: Bun prerequisite line, WSL2 paragraph, `hwf update` behavior.
6. Existing users pick up the new manifest on their next `herdr plugin install`; installs predating `hwf update` run one final manual reinstall.

Rollback is release-level: previous tags remain installable through Herdr's `--ref`. No workflow or config format migrates.

## Open Questions

None. The `b499e611` and Windows OpenTUI questions from the previous revision are moot under WSL-only scope.
