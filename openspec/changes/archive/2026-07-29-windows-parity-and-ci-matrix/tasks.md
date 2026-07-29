## 1. Retained completed work (record — do not redo)

- [x] 1.1 LF normalization via `.gitattributes` with renormalized tree
- [x] 1.3 Detached-run settlement: referenced handles, detach settles outcome, launcher exits
- [x] 1.4 Transport failures name the resolved socket address, distinct from version/protocol/authoring errors
- [x] 1.5 POSIX process-group termination for timeout and capture overflow
- [x] 1.6 Browser opener selection with URL fallback when no opener starts
- [x] 1.7 POSIX credential hardening: user-only modes, state-directory access verification
- [x] 1.8 Native hidden `hwf setup`: CLI install, PATH warning, foreign-entry preservation, keybinding validate/backup/atomic-replace/dead-binding cleanup
- [x] 1.9 Semantic-release foundation: conventional analysis, 0.x breaking rule, manifest prepare step, loop-skip release commit
- [x] 1.10 `hwf update`: release check, version compare, source inspection, linked refusal, synchronous Herdr delegation
- [x] 1.11 Picker update indicator: concurrent nonblocking check, filter-row ASCII indicator, failure silence
- [x] 1.12 Picker CWD moved to invocation repository before mounting
- [x] 1.13 Ubuntu and macOS unit CI legs with explicit timeouts and `fail-fast: false`

## 2. Delete Windows-native code

- [x] 2.1 Delete `src/web/windows-acl.ts`; remove Windows branches and the 15 Windows cases from `src/web/credential-store.ts` / `test/credential-store.test.ts`
- [x] 2.2 Remove the named-pipe branch from `resolveHerdrSocketAddress` in `src/herdr.ts` and its Windows unit cases
- [x] 2.3 Remove `taskkill` termination from `src/run/steps/shell.ts`; keep POSIX process-group kill
- [x] 2.4 Remove `cmd /c start ""` from `src/web/browser.ts`
- [x] 2.5 Remove `%APPDATA%` resolution from `src/setup/paths.ts` and keybinding path handling
- [x] 2.6 Remove `.exe` copy, `hwf.cmd` forwarder, rename-then-place, and `.old-*` sweep from `src/setup/cli-install.ts`; shrink `src/setup/ownership.ts` to symlink-into-checkout plus copy-marker recognition
- [x] 2.7 Remove `.cmd` fixture companions and Windows-only fixture conditionals
- [x] 2.8 Remove the Windows leg from `.github/workflows/verify.yml`; delete `scripts/verify-duplicate-code.ts` if its only purpose was the Windows jscpd skip
- [x] 2.9 Remove Windows branches from `src/update.ts` and `test/update.test.ts` (10.9 verification path); keep `leaveDir`
- [x] 2.10 Drop close-the-picker guidance from `hwf update` output and docs

## 3. Delete binary distribution

- [x] 3.1 Delete `scripts/download-release.sh`, `scripts/download-release.ps1`, and `test/download-release.test.ts`
- [x] 3.2 Delete the native matrix, asset upload, and draft gating from `.github/workflows/release.yml`; keep a minimal semantic-release job
- [x] 3.3 Delete `scripts/release-assets.ts`, `scripts/write-checksums.ts`, `scripts/smoke-release-binary.ts`, `scripts/release-preflight.ts`, `test/release-preflight.test.ts`, and asset assertions in `test/release.test.ts`
- [x] 3.4 Delete `src/smoke-opentui.ts` and its hidden command registration
- [x] 3.5 De-asset `release.config.js`: keep tag, notes, manifest bump, loop-skip commit; publish plain releases, no drafts
- [x] 3.6 Confirm knip passes after deletions (no unreachable modules remain)

## 4. Manifest and install path

- [x] 4.1 Add `scripts/preflight.sh`: use POSIX shell to detect missing or older Bun and fail naming the minimum version before any Bun command runs (~15 lines, tested)
- [x] 4.2 Rewrite `herdr-plugin.toml`: `platforms = ["linux", "macos"]`; build = preflight, `bun install --production --frozen-lockfile`, `bun build --compile`, `bin/herdr-workflows setup`
- [x] 4.3 Verify `bun build --compile src/cli.ts` succeeds with only production dependencies installed
- [x] 4.4 Keep `bun run install:dev` compiling the working tree for linked checkouts
- [ ] 4.5 Verify fresh `herdr plugin install` on clean Linux and macOS hosts with only Bun installed

## 5. Documentation

- [x] 5.1 README install: Bun ≥ minimum prerequisite line; remove binary/checksum/PATH-download prose
- [x] 5.2 Replace the Windows checklist with one WSL2 paragraph; state plainly that native Windows Herdr cannot pair with hwf in WSL
- [x] 5.3 Update `hwf update` docs: no close-picker step; linked-checkout refusal unchanged
- [x] 5.4 Correct AGENTS and smoke-sandbox notes for the reduced platform set

## 6. Final gates

- [x] 6.1 `bun test ./test` on Linux and macOS; `CI=1 npm run verify`; `bun run docs:build`; `git diff --check`
- [x] 6.2 Schema/example generators produce no diff
- [x] 6.3 `openspec validate --all --strict` passes
- [ ] 6.4 After merge, tag the pre-change `main` commit as `v0.1.0`, push the tag, then manually dispatch the first automated release
- [ ] 6.5 Sync delta capabilities into `openspec/specs/` and archive this change (consider renaming at archive to reflect the WSL-only source-install scope)
