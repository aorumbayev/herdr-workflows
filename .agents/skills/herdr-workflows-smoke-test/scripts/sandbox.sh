#!/usr/bin/env bash
# Isolated herdr instance + throwaway git repo for e2e smoke testing herdr-workflows.
# Limitation: `up` still runs `bun run install:dev` against this checkout, so
# `bin/herdr-workflows` is shared with the user's live plugin link — not a private binary.
set -euo pipefail

CANONICAL_SANDBOX="/tmp/hwf-sandbox"
SENTINEL_NAME=".hwf-sandbox-owned"
FIXED_SESSION="hwf-sandbox"

SANDBOX="${HWF_SANDBOX:-$CANONICAL_SANDBOX}"
SESSION="${HWF_SANDBOX_TMUX:-$FIXED_SESSION}"
PLUGIN_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

CFG="$SANDBOX/config"
BIN="$SANDBOX/bin"
REPO="$SANDBOX/repo"
SOCK="$SANDBOX/herdr.sock"
CLIENT_SOCK="$SANDBOX/herdr-client.sock"
HSB="$BIN/hsb"
PLUGIN_STATE="$SANDBOX/state/herdr/plugins/herdr-workflows"
SENTINEL="$SANDBOX/$SENTINEL_NAME"

# Drop inherited herdr/config/socket/bin/plugin overrides that would leak into the live instance.
ISOLATE_UNSET=(
  HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_PLUGIN_CONTEXT_JSON
  HERDR_CONFIG_PATH HERDR_BIN_PATH HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
  HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR HERDR_PLUGIN_DIR
)

assert_sandbox_path() {
  case "$SANDBOX" in
    /tmp/hwf-sandbox) ;;
    *)
      echo "refusing sandbox path outside canonical /tmp/hwf-sandbox: $SANDBOX" >&2
      exit 2
      ;;
  esac
  if [ "$SESSION" != "$FIXED_SESSION" ]; then
    echo "refusing tmux session override '$SESSION' (fixed: $FIXED_SESSION)" >&2
    exit 2
  fi
}

write_sentinel() {
  mkdir -p "$SANDBOX"
  printf 'hwf-sandbox\nsession=%s\nplugin_root=%s\n' "$FIXED_SESSION" "$PLUGIN_ROOT" > "$SENTINEL"
}

assert_valid_sentinel() {
  if [ ! -f "$SENTINEL" ]; then
    echo "refusing: $SANDBOX exists without ownership sentinel $SENTINEL" >&2
    exit 2
  fi
  if ! grep -qx 'hwf-sandbox' "$SENTINEL"; then
    echo "refusing: sentinel does not claim hwf-sandbox ownership" >&2
    exit 2
  fi
}

# Reuse only when a valid sentinel already owns the tree; never claim unknown contents.
claim_or_reuse_sandbox() {
  if [ -e "$SANDBOX" ]; then
    assert_valid_sentinel
  else
    write_sentinel
  fi
}

assert_owned_for_delete() {
  assert_sandbox_path
  if [ ! -f "$SENTINEL" ]; then
    echo "refusing rm: missing ownership sentinel $SENTINEL" >&2
    exit 2
  fi
  if ! grep -qx 'hwf-sandbox' "$SENTINEL"; then
    echo "refusing rm: sentinel does not claim hwf-sandbox ownership" >&2
    exit 2
  fi
}

kill_sandbox_tmux() {
  if ! tmux has-session -t "$FIXED_SESSION" 2>/dev/null; then
    return 0
  fi
  # Kill only when the session's HERDR_SOCKET_PATH exactly matches this sandbox socket.
  # A sentinel alone is never enough — a same-named session may belong to something else.
  local sock_env
  sock_env="$(tmux show-environment -t "$FIXED_SESSION" HERDR_SOCKET_PATH 2>/dev/null || true)"
  case "$sock_env" in
    "HERDR_SOCKET_PATH=$SOCK")
      tmux kill-session -t "$FIXED_SESSION" 2>/dev/null || true
      ;;
    *)
      echo "refusing tmux kill-session: $FIXED_SESSION HERDR_SOCKET_PATH does not match $SOCK" >&2
      exit 2
      ;;
  esac
}

isolated() {
  local -a unset_flags=()
  local v
  for v in "${ISOLATE_UNSET[@]}"; do
    unset_flags+=(-u "$v")
  done
  env "${unset_flags[@]}" \
      HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
      XDG_CONFIG_HOME="$CFG" XDG_STATE_HOME="$SANDBOX/state" XDG_BIN_HOME="$BIN" \
      HERDR_SOCKET_PATH="$SOCK" HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
      PATH="$BIN:$PATH" "$@"
}

server_running() {
  # No pipe: `| grep -q` races with pipefail (grep exits first, herdr takes SIGPIPE).
  local out
  out="$(isolated herdr status 2>/dev/null)" || return 1
  case "$out" in *'status: running'*) return 0 ;; *) return 1 ;; esac
}

write_wrapper() {
  mkdir -p "$BIN"
  local unset_args=""
  local v
  for v in "${ISOLATE_UNSET[@]}"; do
    unset_args+=" -u $v"
  done
  cat > "$HSB" <<EOF
#!/usr/bin/env bash
# Runs any command against the sandbox herdr instead of the user's live one.
# Unsets inherited herdr config/socket/bin/plugin vars so a poisoned caller env cannot leak.
exec env$unset_args \\
  HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \\
  XDG_CONFIG_HOME="$CFG" XDG_STATE_HOME="$SANDBOX/state" XDG_BIN_HOME="$BIN" \\
  HERDR_SOCKET_PATH="$SOCK" HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \\
  PATH="$BIN:\$PATH" "\$@"
EOF
  chmod +x "$HSB"
}

seed_config() {
  mkdir -p "$CFG/herdr"
  # allow_nested: the sandbox herdr runs inside a herdr-managed pane, which herdr
  # refuses by default. Only written on first `up` so install:dev's appended
  # keybindings survive later runs.
  # ui.toast delivery: without it notification.show answers {"shown":false,"reason":"disabled"}
  # and every notification step passes while showing nothing.
  # worktrees.directory: the default is the real ~/.herdr/worktrees, so a worktree.create
  # test would litter the user's home instead of the sandbox.
  [ -f "$CFG/herdr/config.toml" ] ||
    printf '[experimental]\nallow_nested = true\n\n[ui.toast]\ndelivery = "herdr"\n\n[worktrees]\ndirectory = "%s/worktrees"\n' \
      "$SANDBOX" > "$CFG/herdr/config.toml"
}

seed_repo() {
  [ -d "$REPO/.git" ] && return 0
  mkdir -p "$REPO/src"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email sandbox@example.invalid
  git -C "$REPO" config user.name "hwf sandbox"
  printf '# hwf sandbox\n\nThrowaway repo. Anything here is disposable.\n' > "$REPO/README.md"
  printf 'export const greet = (name: string) => `hi ${name}`\n' > "$REPO/src/app.ts"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "initial sandbox commit"
  git -C "$REPO" branch feature/sandbox
  # Leave a dirty tree so workflows gated on `git diff HEAD` have something to see.
  printf 'export const farewell = (name: string) => `bye ${name}`\n' >> "$REPO/src/app.ts"
}

start_server() {
  if server_running; then return 0; fi
  kill_sandbox_tmux
  tmux new-session -d -s "$FIXED_SESSION" -x 200 -y 50 -c "$REPO" \
    -e XDG_CONFIG_HOME="$CFG" -e XDG_STATE_HOME="$SANDBOX/state" -e XDG_BIN_HOME="$BIN" \
    -e HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
    -e HERDR_SOCKET_PATH="$SOCK" -e HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
    -e HERDR_PANE_ID= -e HERDR_TAB_ID= -e HERDR_WORKSPACE_ID= -e HERDR_ENV= \
    -e HERDR_CONFIG_PATH= -e HERDR_BIN_PATH= -e HERDR_PLUGIN_CONFIG_DIR= \
    "PATH=$BIN:\$PATH herdr; echo '[sandbox herdr exited]'; sleep 86400"
  for _ in $(seq 1 40); do
    server_running && return 0
    sleep 0.5
  done
  echo "sandbox herdr did not come up; tmux capture-pane -p -t $FIXED_SESSION" >&2
  tmux capture-pane -p -t "$FIXED_SESSION" 2>/dev/null | head -20 >&2
  return 1
}

verify() {
  mkdir -p "$REPO/.hwf/workflows"
  printf 'version: v1alpha1\ndescription: sandbox self-check\nsteps:\n  - run: echo hwf-sandbox-ok\n' > "$REPO/.hwf/workflows/sandbox-selfcheck.yaml"
  local out
  out="$(cd "$REPO" && isolated hwf run sandbox-selfcheck 2>&1)" || {
    echo "$out" >&2; echo "self-check failed: hwf run errored" >&2; return 1
  }
  case "$out" in
    *hwf-sandbox-ok*|*succeeded*) return 0 ;;
    *) echo "$out" >&2; echo "self-check failed: workflow output missing" >&2; return 1 ;;
  esac
}

up() {
  assert_sandbox_path
  claim_or_reuse_sandbox
  seed_config
  write_wrapper
  seed_repo
  start_server
  # Always reinstall: the point of the sandbox is testing the current working tree.
  # Limitation: this rebuilds the shared checkout bin/herdr-workflows; the user's live
  # herdr picks up the same binary on its next plugin action. Not sandbox-private.
  (cd "$PLUGIN_ROOT" && isolated bun run install:dev)
  [ -f "$REPO/.hwf/config.yaml" ] || (cd "$REPO" && isolated hwf init)
  verify
  status
}

down() {
  assert_owned_for_delete
  if server_running; then isolated herdr server stop >/dev/null 2>&1 || true; fi
  kill_sandbox_tmux
  rm -rf -- "$SANDBOX"
  echo "sandbox removed: $SANDBOX"
}

status() {
  assert_sandbox_path
  echo "sandbox:     $SANDBOX"
  echo "repo:        $REPO"
  echo "wrapper:     $HSB <any command>"
  echo "tmux:        tmux attach -t $FIXED_SESSION"
  echo "limitation:  shared checkout binary (install:dev mutates bin/herdr-workflows)"
  printf 'tmux alive:  '; tmux has-session -t "$FIXED_SESSION" 2>/dev/null && echo yes || echo no
  printf 'server:      '; server_running && echo running || echo "not running"
  echo "plugins:"; isolated herdr plugin list 2>&1 | sed 's/^/  /'
  echo "workflows:"; ls "$REPO/.hwf/workflows" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
}

# Non-destructive ownership / tmux-kill guard checks. Never starts herdr or mutates a live sandbox.
guard_check() {
  assert_sandbox_path
  local failed=0
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/hwf-sandbox-guard.XXXXXX")"
  cleanup_guard() { rm -rf -- "$tmp"; }
  trap cleanup_guard EXIT

  # 1) Existing tree without sentinel → refuse (logic mirrored; do not touch /tmp/hwf-sandbox).
  mkdir -p "$tmp/no-sentinel"
  if [ -f "$tmp/no-sentinel/$SENTINEL_NAME" ]; then
    echo "guard-check fail: unexpected sentinel in fixture" >&2
    failed=1
  else
    echo "guard-check ok: missing-sentinel path would refuse reuse"
  fi

  # 2) Invalid sentinel contents → refuse.
  mkdir -p "$tmp/bad-sentinel"
  printf 'not-ours\n' > "$tmp/bad-sentinel/$SENTINEL_NAME"
  if grep -qx 'hwf-sandbox' "$tmp/bad-sentinel/$SENTINEL_NAME"; then
    echo "guard-check fail: invalid sentinel unexpectedly matched" >&2
    failed=1
  else
    echo "guard-check ok: invalid sentinel would refuse reuse"
  fi

  # 3) Valid sentinel → reusable.
  mkdir -p "$tmp/good"
  printf 'hwf-sandbox\nsession=%s\n' "$FIXED_SESSION" > "$tmp/good/$SENTINEL_NAME"
  if ! grep -qx 'hwf-sandbox' "$tmp/good/$SENTINEL_NAME"; then
    echo "guard-check fail: valid sentinel rejected" >&2
    failed=1
  else
    echo "guard-check ok: valid sentinel allows reuse"
  fi

  # 4) kill_sandbox_tmux requires exact HERDR_SOCKET_PATH match (sentinel insufficient).
  if tmux has-session -t "$FIXED_SESSION" 2>/dev/null; then
    local sock_env
    sock_env="$(tmux show-environment -t "$FIXED_SESSION" HERDR_SOCKET_PATH 2>/dev/null || true)"
    case "$sock_env" in
      "HERDR_SOCKET_PATH=$SOCK")
        echo "guard-check ok: live $FIXED_SESSION socket matches sandbox (kill allowed)"
        ;;
      *)
        echo "guard-check ok: live $FIXED_SESSION socket mismatch would refuse kill (got: ${sock_env:-<unset>})"
        ;;
    esac
  else
    # Throwaway same-named session with a non-sandbox socket; expect refuse, then clean it up.
    # Subshell so kill_sandbox_tmux's `exit 2` does not abort this check.
    local probe="hwf-sandbox-guard-probe-$$"
    if ! tmux new-session -d -s "$FIXED_SESSION" -e HERDR_SOCKET_PATH="/tmp/$probe.sock" "sleep 30" 2>/dev/null; then
      echo "guard-check fail: could not create probe tmux session" >&2
      failed=1
    else
      if ( kill_sandbox_tmux ) 2>"$tmp/kill.err"; then
        echo "guard-check fail: kill_sandbox_tmux killed mismatched socket session" >&2
        failed=1
      elif grep -q 'HERDR_SOCKET_PATH does not match' "$tmp/kill.err"; then
        echo "guard-check ok: kill_sandbox_tmux refused mismatched socket"
      else
        echo "guard-check fail: unexpected kill refusal: $(cat "$tmp/kill.err")" >&2
        failed=1
      fi
      tmux kill-session -t "$FIXED_SESSION" 2>/dev/null || true
    fi
  fi

  # 5) Live canonical sandbox: never claim/overwrite unknown contents.
  if [ -e "$SANDBOX" ]; then
    if [ -f "$SENTINEL" ] && grep -qx 'hwf-sandbox' "$SENTINEL"; then
      echo "guard-check ok: canonical $SANDBOX has valid sentinel (reuse allowed)"
    else
      echo "guard-check ok: canonical $SANDBOX present without valid sentinel (up would refuse)"
    fi
  else
    echo "guard-check ok: canonical $SANDBOX absent (up would create + claim)"
  fi

  trap - EXIT
  cleanup_guard
  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
  echo "guard-check passed"
}

assert_sandbox_path

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  guard-check) guard_check ;;
  *) echo "usage: sandbox.sh [up|down|status|guard-check]" >&2; exit 2 ;;
esac
