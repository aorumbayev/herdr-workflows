#!/usr/bin/env bash
# Isolated herdr instance + throwaway git repo for e2e smoke testing herdr-workflows.
# Limitation: `up` still runs `go build -o bin/herdr-workflows .` and `bin/herdr-workflows setup`
# against this checkout, so `bin/herdr-workflows` is shared with the user's live plugin link — not a private binary.
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

# Complete ownership proof for sandbox root $1 (default: $SANDBOX).
# Lines required: hwf-sandbox, session=<fixed>, plugin_root=<this checkout>.
assert_owned_sentinel() {
  local root="${1:-$SANDBOX}"
  local sentinel="$root/$SENTINEL_NAME"
  if [ ! -f "$sentinel" ] || [ -L "$sentinel" ]; then
    echo "refusing: $root exists without ownership sentinel $sentinel" >&2
    exit 2
  fi
  if ! grep -Fqx 'hwf-sandbox' "$sentinel"; then
    echo "refusing: sentinel does not claim hwf-sandbox ownership" >&2
    exit 2
  fi
  if ! grep -Fqx "session=$FIXED_SESSION" "$sentinel"; then
    echo "refusing: sentinel session identity mismatch (want session=$FIXED_SESSION)" >&2
    exit 2
  fi
  if ! grep -Fqx "plugin_root=$PLUGIN_ROOT" "$sentinel"; then
    echo "refusing: sentinel plugin_root mismatch (want plugin_root=$PLUGIN_ROOT)" >&2
    exit 2
  fi
}

write_sentinel() {
  printf 'hwf-sandbox\nsession=%s\nplugin_root=%s\n' "$FIXED_SESSION" "$PLUGIN_ROOT" > "$SENTINEL"
}

# Exclusive mkdir claims an absent path. Existing trees must already carry a complete sentinel.
# Never claim or overwrite unknown contents.
claim_or_reuse_sandbox() {
  if mkdir "$SANDBOX" 2>/dev/null; then
    write_sentinel
  elif [ -e "$SANDBOX" ]; then
    assert_owned_sentinel
  else
    echo "refusing: cannot create sandbox directory $SANDBOX" >&2
    exit 2
  fi
}

assert_owned_for_delete() {
  assert_sandbox_path
  assert_owned_sentinel
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
  # refuses by default. Only written on first `up` so setup's appended
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
  (cd "$PLUGIN_ROOT" && go build -o bin/herdr-workflows .)
  (cd "$PLUGIN_ROOT" && isolated bin/herdr-workflows setup)
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
  echo "limitation:  shared checkout binary (go build + setup mutates bin/herdr-workflows)"
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

  # 1) Existing tree without sentinel → refuse.
  mkdir -p "$tmp/no-sentinel"
  if ( assert_owned_sentinel "$tmp/no-sentinel" ) 2>"$tmp/no-sentinel.err"; then
    echo "guard-check fail: missing sentinel unexpectedly accepted" >&2
    failed=1
  elif grep -q 'without ownership sentinel' "$tmp/no-sentinel.err"; then
    echo "guard-check ok: missing-sentinel path refused"
  else
    echo "guard-check fail: unexpected missing-sentinel error: $(cat "$tmp/no-sentinel.err")" >&2
    failed=1
  fi

  # 2) Marker line only, missing session/plugin_root → refuse.
  mkdir -p "$tmp/partial-sentinel"
  printf 'hwf-sandbox\n' > "$tmp/partial-sentinel/$SENTINEL_NAME"
  if ( assert_owned_sentinel "$tmp/partial-sentinel" ) 2>"$tmp/partial.err"; then
    echo "guard-check fail: partial sentinel unexpectedly accepted" >&2
    failed=1
  elif grep -q 'session identity mismatch' "$tmp/partial.err"; then
    echo "guard-check ok: partial sentinel refused"
  else
    echo "guard-check fail: unexpected partial-sentinel error: $(cat "$tmp/partial.err")" >&2
    failed=1
  fi

  # 3) Wrong plugin_root → refuse.
  mkdir -p "$tmp/wrong-root"
  printf 'hwf-sandbox\nsession=%s\nplugin_root=/not/this/checkout\n' "$FIXED_SESSION" \
    > "$tmp/wrong-root/$SENTINEL_NAME"
  if ( assert_owned_sentinel "$tmp/wrong-root" ) 2>"$tmp/wrong.err"; then
    echo "guard-check fail: wrong plugin_root unexpectedly accepted" >&2
    failed=1
  elif grep -q 'plugin_root mismatch' "$tmp/wrong.err"; then
    echo "guard-check ok: wrong plugin_root refused"
  else
    echo "guard-check fail: unexpected wrong-root error: $(cat "$tmp/wrong.err")" >&2
    failed=1
  fi

  # 4) Complete sentinel → accepted.
  mkdir -p "$tmp/good"
  printf 'hwf-sandbox\nsession=%s\nplugin_root=%s\n' "$FIXED_SESSION" "$PLUGIN_ROOT" \
    > "$tmp/good/$SENTINEL_NAME"
  if ( assert_owned_sentinel "$tmp/good" ) 2>"$tmp/good.err"; then
    echo "guard-check ok: complete sentinel accepted"
  else
    echo "guard-check fail: complete sentinel rejected: $(cat "$tmp/good.err")" >&2
    failed=1
  fi

  # 5) Symlink sentinel → refuse even when its target has complete contents.
  mkdir -p "$tmp/symlink"
  ln -s "$tmp/good/$SENTINEL_NAME" "$tmp/symlink/$SENTINEL_NAME"
  if ( assert_owned_sentinel "$tmp/symlink" ) 2>"$tmp/symlink.err"; then
    echo "guard-check fail: symlink sentinel unexpectedly accepted" >&2
    failed=1
  elif grep -q 'without ownership sentinel' "$tmp/symlink.err"; then
    echo "guard-check ok: symlink sentinel refused"
  else
    echo "guard-check fail: unexpected symlink-sentinel error: $(cat "$tmp/symlink.err")" >&2
    failed=1
  fi

  # 6) kill_sandbox_tmux requires exact HERDR_SOCKET_PATH match (sentinel insufficient).
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

  # 7) Live canonical sandbox: never claim/overwrite unknown contents.
  if [ -e "$SANDBOX" ]; then
    if ( assert_owned_sentinel ) 2>/dev/null; then
      echo "guard-check ok: canonical $SANDBOX has complete sentinel (reuse allowed)"
    else
      echo "guard-check ok: canonical $SANDBOX present without complete sentinel (up/down would refuse)"
    fi
  else
    echo "guard-check ok: canonical $SANDBOX absent (up would mkdir + claim)"
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
