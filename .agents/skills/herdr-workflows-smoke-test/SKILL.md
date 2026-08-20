---
name: herdr-workflows-smoke-test
description: Throwaway Herdr instance in tmux for user-directed end-to-end smoke tests of this plugin, isolated from the user's live Herdr panes. Use when the user asks to smoke-test the plugin, run e2e tests against a real Herdr, start a sandbox Herdr, or tear the sandbox down. For development of this herdr-workflows repository.
---

# herdr-workflows smoke-test sandbox

Run the plugin against a second Herdr instance. A broken build, a bad keybinding, or a runaway workflow must not damage the Herdr panes the user is using.

This skill belongs to the herdr-workflows repository. Do not assume a fixed absolute repository location or a fixed working directory — "Bring it up" shows how the root is derived.

**Shared binary limit:** `up` still runs `go build -o bin/herdr-workflows .` and then `bin/herdr-workflows setup` in this checkout. That rebuilds shared `bin/herdr-workflows`. The user's live Herdr picks up the same binary on its next plugin action. Config, socket, and panes are isolated. The plugin binary is not.

**Platforms:** This smoke sandbox is POSIX/tmux-only (Linux and macOS). Windows users run Herdr and this plugin inside WSL2. Do not point the sandbox at a native Windows Herdr.

## Bring it up

From any cwd inside this repository:

```bash
repo_root=$(git rev-parse --show-toplevel)
bash "$repo_root/.agents/skills/herdr-workflows-smoke-test/scripts/sandbox.sh" up
```

Callers outside the repository must substitute an absolute path to the checkout for `$repo_root`.

`sandbox.sh` sets `PLUGIN_ROOT` from its own location (`scripts/../../../../`). That resolves to the repository root under `.agents/skills/<skill>/scripts/`.

`up` is idempotent only when `/tmp/hwf-sandbox` is absent or already owned (complete `.hwf-sandbox-owned` sentinel). It:

1. Claims `/tmp/hwf-sandbox` with an exclusive `mkdir` when the path is absent, then writes the ownership sentinel (`hwf-sandbox`, `session=hwf-sandbox`, `plugin_root=<this checkout>`). If the path already exists, it validates that complete sentinel (session and plugin-root must match) and reuses the tree. It refuses missing, partial, or mismatched sentinels. It never overwrites or claims unknown contents. It refuses paths outside `/tmp/hwf-sandbox`.
2. Seeds `repo/` as a git repo (initial commit, a `feature/sandbox` branch, a dirty `src/app.ts` so `git diff HEAD` is non-empty).
3. Starts Herdr in fixed tmux session `hwf-sandbox` on its own socket. The session name is not overridable. Kill only when that session's `HERDR_SOCKET_PATH` exactly matches the sandbox socket. A sentinel alone is never enough.
4. Runs `go build -o bin/herdr-workflows .` and then `bin/herdr-workflows setup` against that instance (**shared binary mutation**).
5. Runs `hwf init`, then proves the chain with a `sandbox-selfcheck` workflow.

Other actions: `sandbox.sh status`, `sandbox.sh down` (stops the server, kills the `hwf-sandbox` tmux session only when its socket matches, deletes `/tmp/hwf-sandbox` only after the same complete ownership validator passes), `sandbox.sh guard-check` (non-destructive ownership and kill-guard checks. Never starts Herdr).

Inherited `HERDR_CONFIG_PATH` / `HERDR_BIN_PATH` / `HERDR_SOCKET_*` / plugin-dir overrides are unset before sandbox commands. A poisoned caller env cannot retarget the live instance.

## Run every command through `hsb`

`hsb` is generated at `/tmp/hwf-sandbox/bin/hsb`. It runs any command with the sandbox env (`XDG_CONFIG_HOME`, `XDG_BIN_HOME`, `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, cleared inherited HERDR overrides, and `hwf` on `PATH`).

```bash
S=/tmp/hwf-sandbox
$S/bin/hsb herdr pane list
cd $S/repo && $S/bin/hsb hwf run <name>
```

A bare `herdr` or `hwf` talks to the user's live instance. There is no warning and no undo. A `pane.close` or a `worktree.create` lands in their real session. Never omit `hsb`.

## What is and is not isolated

| Isolated                                                 | Shared with the user's Herdr                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| config.toml, keybindings, plugin registry, plugin config | the compiled `bin/herdr-workflows` (same checkout)             |
| socket, server process, panes, workspaces, sessions      | this checkout's working tree and git state                     |
| `XDG_BIN_HOME` shims (go to `/tmp/hwf-sandbox/bin`)      | anything a workflow shells out to (network, `gh`, and similar) |

Say so in the report if a test leaves the shared binary in a broken state.

## Driving and observing

- Prefer headless: `hsb herdr pane list | send-keys | send-text | read | wait-output`, and `hsb herdr agent list | read | prompt | wait`. Check flags with `hsb herdr pane read --help`.
- For the TUI itself: `tmux capture-pane -p -t hwf-sandbox` to read the screen, `tmux send-keys -t hwf-sandbox ...` for keybindings such as `prefix+k` (the picker).
- To watch live: `tmux attach -t hwf-sandbox` (detach with `Ctrl-b d`).
- Plugin logs: `hsb herdr plugin log herdr-workflows`.

## After `up`, stop and ask

Report the sandbox status. Wait for the user to name what to smoke test. Do not invent a test plan. When they name something:

1. Write or edit the workflow under `/tmp/hwf-sandbox/repo/.hwf/workflows/`. Never write it in this checkout (the `.hwf/` here is the user's own).
2. Run it with `hsb`. Capture the real output.
3. Report what happened verbatim, including failures. A workflow that loaded but did the wrong thing is a finding, not a retry.

For YAML syntax, load errors, and the Herdr method allowlist, use the `herdr-workflow-create` skill in `skills/herdr-workflow-create/`. Do not re-derive the DSL.

## Gotchas seen for real

- Herdr refuses to launch inside a Herdr-managed pane. The sandbox config sets `[experimental] allow_nested = true`. That is why `up` must not overwrite an existing `config.toml`.
- `hwf run` needs the sandbox repo as cwd. Workflow lookup is repo-rooted.
- `herdr server reload-config` needs the sandbox server already up. Never run the Go build and `setup` before `sandbox.sh up` has started it.
- For a cold start over a leftover owned sandbox, run `down` first — `up` reuses an owned `/tmp/hwf-sandbox` as-is.
