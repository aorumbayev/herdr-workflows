#!/usr/bin/env bash
# Dual isolated Herdr + Go/TS picker visual compare.
# Comparison-only: TypeScript runs from a throwaway worktree of the last pre-Go commit.
# Never touches canonical /tmp/hwf-sandbox, session hwf-sandbox, or the live Herdr socket.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
TS_SHA="${HWF_PC_TS_SHA:-5fcf263df2329901f16cc4bc2088df26d318dd04}"
TS_SRC="${HWF_PC_TS_SRC:-/tmp/hwf-picker-compare-ts-src}"

GO_ROOT="${HWF_PC_GO_ROOT:-/tmp/hwf-picker-compare-go}"
TS_ROOT="${HWF_PC_TS_ROOT:-/tmp/hwf-picker-compare-ts}"
GO_SESSION="${HWF_PC_GO_SESSION:-hwf-pc-go}"
TS_SESSION="${HWF_PC_TS_SESSION:-hwf-pc-ts}"
# Herdr owns its host tmux session UI — picker TUI must live in a sibling session.
GO_UI_SESSION="${HWF_PC_GO_UI_SESSION:-hwf-pc-go-ui}"
TS_UI_SESSION="${HWF_PC_TS_UI_SESSION:-hwf-pc-ts-ui}"
CAPTURE_DIR="${HWF_PC_CAPTURE_DIR:-/tmp/hwf-picker-compare-captures}"

SENTINEL_NAME=".hwf-picker-compare-owned"
COLS=80
ROWS=24

ISOLATE_UNSET=(
  HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_PLUGIN_CONTEXT_JSON
  HERDR_CONFIG_PATH HERDR_BIN_PATH HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
  HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR HERDR_PLUGIN_DIR
)

VIEWS=(workflow-list filter palette inputs runs-list runs-detail)

die() { echo "picker-visual-compare: $*" >&2; exit 2; }

assert_not_canonical_sandbox() {
  case "$GO_ROOT" in /tmp/hwf-sandbox|/tmp/hwf-sandbox/*) die "refusing Go root that overlaps /tmp/hwf-sandbox" ;; esac
  case "$TS_ROOT" in /tmp/hwf-sandbox|/tmp/hwf-sandbox/*) die "refusing TS root that overlaps /tmp/hwf-sandbox" ;; esac
  case "$CAPTURE_DIR" in /tmp/hwf-sandbox|/tmp/hwf-sandbox/*) die "refusing capture dir that overlaps /tmp/hwf-sandbox" ;; esac
  for s in "$GO_SESSION" "$TS_SESSION" "$GO_UI_SESSION" "$TS_UI_SESSION"; do
    if [ "$s" = "hwf-sandbox" ]; then
      die "refusing canonical hwf-sandbox session name"
    fi
  done
  if [ "$GO_SESSION" = "$TS_SESSION" ]; then
    die "Go and TS herdr sessions must differ"
  fi
  if [ "$GO_UI_SESSION" = "$TS_UI_SESSION" ]; then
    die "Go and TS UI sessions must differ"
  fi
  if [ "$GO_SESSION" = "$GO_UI_SESSION" ] || [ "$TS_SESSION" = "$TS_UI_SESSION" ]; then
    die "herdr session and UI session must differ (herdr owns its host session)"
  fi
}

assert_owned() {
  local root="$1" tag="$2" session="$3"
  local sentinel="$root/$SENTINEL_NAME"
  [ -f "$sentinel" ] || die "refusing: $root missing ownership sentinel"
  [ ! -L "$sentinel" ] || die "refusing: $root sentinel must not be a symlink"
  grep -Fqx 'hwf-picker-compare' "$sentinel" || die "refusing: $root sentinel missing hwf-picker-compare marker"
  grep -Fqx "tag=$tag" "$sentinel" || die "refusing: $root sentinel tag mismatch (want tag=$tag)"
  grep -Fqx "session=$session" "$sentinel" || die "refusing: $root sentinel session mismatch"
  grep -Fqx "plugin_root=$PLUGIN_ROOT" "$sentinel" || die "refusing: $root plugin_root mismatch"
}

write_sentinel() {
  local root="$1" tag="$2" session="$3"
  printf 'hwf-picker-compare\ntag=%s\nsession=%s\nplugin_root=%s\nts_sha=%s\n' \
    "$tag" "$session" "$PLUGIN_ROOT" "$TS_SHA" > "$root/$SENTINEL_NAME"
}

claim_or_reuse() {
  local root="$1" tag="$2" session="$3"
  if mkdir "$root" 2>/dev/null; then
    write_sentinel "$root" "$tag" "$session"
  elif [ -e "$root" ]; then
    assert_owned "$root" "$tag" "$session"
  else
    die "cannot create $root"
  fi
}

paths_for() {
  local side="$1"
  if [ "$side" = go ]; then
    ROOT="$GO_ROOT"; SESSION="$GO_SESSION"; UI_SESSION="$GO_UI_SESSION"; TAG=go
  else
    ROOT="$TS_ROOT"; SESSION="$TS_SESSION"; UI_SESSION="$TS_UI_SESSION"; TAG=ts
  fi
  CFG="$ROOT/config"
  BIN="$ROOT/bin"
  REPO="$ROOT/repo"
  SOCK="$ROOT/herdr.sock"
  CLIENT_SOCK="$ROOT/herdr-client.sock"
  PLUGIN_STATE="$ROOT/state/herdr/plugins/herdr-workflows"
  HSB="$BIN/hsb"
}

isolated() {
  local -a unset_flags=()
  local v
  for v in "${ISOLATE_UNSET[@]}"; do
    unset_flags+=(-u "$v")
  done
  env "${unset_flags[@]}" \
    HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
    XDG_CONFIG_HOME="$CFG" XDG_STATE_HOME="$ROOT/state" XDG_BIN_HOME="$BIN" \
    HERDR_SOCKET_PATH="$SOCK" HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
    PATH="$BIN:$PATH" "$@"
}

write_wrapper() {
  mkdir -p "$BIN"
  local unset_args="" v
  for v in "${ISOLATE_UNSET[@]}"; do
    unset_args+=" -u $v"
  done
  cat > "$HSB" <<EOF
#!/usr/bin/env bash
exec env$unset_args \\
  HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \\
  XDG_CONFIG_HOME="$CFG" XDG_STATE_HOME="$ROOT/state" XDG_BIN_HOME="$BIN" \\
  HERDR_SOCKET_PATH="$SOCK" HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \\
  PATH="$BIN:\$PATH" "\$@"
EOF
  chmod +x "$HSB"
}

seed_config() {
  mkdir -p "$CFG/herdr"
  [ -f "$CFG/herdr/config.toml" ] ||
    printf '[experimental]\nallow_nested = true\n\n[ui.toast]\ndelivery = "herdr"\n\n[worktrees]\ndirectory = "%s/worktrees"\n' \
      "$ROOT" > "$CFG/herdr/config.toml"
}

seed_repo() {
  if [ -d "$REPO/.git" ]; then
    return 0
  fi
  mkdir -p "$REPO/src" "$REPO/.hwf/workflows"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email picker-compare@example.invalid
  git -C "$REPO" config user.name "hwf picker compare"
  printf '# picker compare fixture\n' > "$REPO/README.md"
  printf 'export const greet = (name: string) => `hi ${name}`\n' > "$REPO/src/app.ts"
  # Identical catalog on both sides (copy from this checkout's examples + a tiny no-input workflow).
  cp "$PLUGIN_ROOT/examples/branch-check.yaml" "$REPO/.hwf/workflows/branch-check.yaml"
  cp "$PLUGIN_ROOT/examples/remote-branch-log.yaml" "$REPO/.hwf/workflows/remote-branch-log.yaml"
  printf 'version: v1alpha1\ndescription: compare-fixture echo\nsteps:\n  - run: [echo, picker-compare-ok]\n' \
    > "$REPO/.hwf/workflows/compare-echo.yaml"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "picker compare fixture"
  git -C "$REPO" branch feature/compare
  printf 'export const farewell = (name: string) => `bye ${name}`\n' >> "$REPO/src/app.ts"
}

# Seed enough run history for runs list + detail (checkout_root must match resolved repo path).
seed_run_history() {
  local runs="$PLUGIN_STATE/runs"
  mkdir -p "$PLUGIN_STATE" "$runs"
  chmod 0700 "$PLUGIN_STATE" "$runs"
  local now root_json id1 id2
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  # macOS: /tmp -> /private/tmp; picker resolves the real path for Current scope.
  root_json="$(cd "$REPO" && pwd -P)"
  id1="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1"
  id2="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2"
  printf '%s\n' "{\"version\":1,\"id\":\"$id1\",\"workflow\":\"compare-echo\",\"title\":\"Compare echo\",\"source\":\"repo\",\"checkout_root\":\"$root_json\",\"started_at\":\"$now\",\"heartbeat_at\":\"$now\",\"finished_at\":\"$now\",\"status\":\"succeeded\",\"steps\":[]}" \
    > "$runs/$id1.json"
  printf '%s\n' "{\"version\":1,\"id\":\"$id2\",\"workflow\":\"branch-check\",\"title\":\"Branch check\",\"source\":\"repo\",\"checkout_root\":\"$root_json\",\"started_at\":\"$now\",\"heartbeat_at\":\"$now\",\"finished_at\":\"$now\",\"status\":\"failed\",\"failure_explanation\":\"seeded compare failure\",\"steps\":[]}" \
    > "$runs/$id2.json"
  chmod 0600 "$runs/$id1.json" "$runs/$id2.json"
}

server_running() {
  local out
  out="$(isolated herdr status 2>/dev/null)" || return 1
  case "$out" in *'status: running'*) return 0 ;; *) return 1 ;; esac
}

kill_session_if_ours() {
  local session="$1" sock="$2"
  if ! tmux has-session -t "$session" 2>/dev/null; then
    return 0
  fi
  local sock_env
  sock_env="$(tmux show-environment -t "$session" HERDR_SOCKET_PATH 2>/dev/null || true)"
  case "$sock_env" in
    "HERDR_SOCKET_PATH=$sock")
      tmux kill-session -t "$session" 2>/dev/null || true
      ;;
    *)
      die "refusing tmux kill-session: $session HERDR_SOCKET_PATH does not match $sock (got: ${sock_env:-<unset>})"
      ;;
  esac
}

ensure_ui_session() {
  # Sibling session for the picker TUI — never the herdr-owned session.
  if tmux has-session -t "$UI_SESSION" 2>/dev/null; then
    local sock_env
    sock_env="$(tmux show-environment -t "$UI_SESSION" HERDR_SOCKET_PATH 2>/dev/null || true)"
    case "$sock_env" in
      "HERDR_SOCKET_PATH=$SOCK") return 0 ;;
      *)
        die "refusing UI session $UI_SESSION: HERDR_SOCKET_PATH mismatch (got: ${sock_env:-<unset>})"
        ;;
    esac
  fi
  tmux new-session -d -s "$UI_SESSION" -x "$COLS" -y "$ROWS" -c "$REPO" \
    -e XDG_CONFIG_HOME="$CFG" -e XDG_STATE_HOME="$ROOT/state" -e XDG_BIN_HOME="$BIN" \
    -e HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
    -e HERDR_SOCKET_PATH="$SOCK" -e HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
    -e HERDR_PANE_ID= -e HERDR_TAB_ID= -e HERDR_WORKSPACE_ID= -e HERDR_ENV= \
    -e HERDR_CONFIG_PATH= -e HERDR_BIN_PATH= -e HERDR_PLUGIN_CONFIG_DIR= \
    "bash --norc --noprofile"
}

start_server() {
  if server_running; then
    ensure_ui_session
    return 0
  fi
  kill_session_if_ours "$SESSION" "$SOCK"
  # Kill UI session only when it points at this sandbox socket.
  if tmux has-session -t "$UI_SESSION" 2>/dev/null; then
    kill_session_if_ours "$UI_SESSION" "$SOCK"
  fi
  tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$REPO" \
    -e XDG_CONFIG_HOME="$CFG" -e XDG_STATE_HOME="$ROOT/state" -e XDG_BIN_HOME="$BIN" \
    -e HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
    -e HERDR_SOCKET_PATH="$SOCK" -e HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
    -e HERDR_PANE_ID= -e HERDR_TAB_ID= -e HERDR_WORKSPACE_ID= -e HERDR_ENV= \
    -e HERDR_CONFIG_PATH= -e HERDR_BIN_PATH= -e HERDR_PLUGIN_CONFIG_DIR= \
    "PATH=$BIN:\$PATH herdr; echo '[compare herdr exited]'; sleep 86400"
  for _ in $(seq 1 40); do
    if server_running; then
      ensure_ui_session
      return 0
    fi
    sleep 0.5
  done
  echo "herdr did not come up in $SESSION; capture:" >&2
  tmux capture-pane -p -t "$SESSION:0" 2>/dev/null | head -20 >&2
  return 1
}

build_go_private() {
  # Sandbox-private binary — does not mutate checkout bin/herdr-workflows.
  mkdir -p "$GO_ROOT/bin"
  (cd "$PLUGIN_ROOT" && go build -o "$GO_ROOT/bin/herdr-workflows" .)
  ln -sfn herdr-workflows "$GO_ROOT/bin/hwf"
}

build_ts_private() {
  [ -d "$TS_SRC" ] || die "TS worktree missing at $TS_SRC (expected SHA $TS_SHA)"
  local head
  head="$(git -C "$TS_SRC" rev-parse HEAD)"
  [ "$head" = "$TS_SHA" ] || die "TS worktree HEAD $head != expected $TS_SHA"
  mkdir -p "$TS_ROOT/bin"
  (
    cd "$TS_SRC"
    if [ ! -d node_modules ]; then
      bun install --frozen-lockfile
    fi
    # Compile into the TS sandbox bin. OpenTUI still needs node_modules — set OTUI_ASSET_ROOT.
    bun build --compile --outfile="$TS_ROOT/bin/herdr-workflows" src/cli.ts
  )
  ln -sfn herdr-workflows "$TS_ROOT/bin/hwf"
  # Point compiled binary at the worktree native OpenTUI libs.
  printf '%s\n' "$TS_SRC/node_modules" > "$TS_ROOT/otui-asset-root.txt"
}

setup_plugin_side() {
  local binary="$BIN/herdr-workflows"
  [ -x "$binary" ] || die "missing binary $binary"
  isolated "$binary" setup
  if [ ! -f "$REPO/.hwf/config.yaml" ]; then
    (cd "$REPO" && isolated hwf init)
  fi
}

picker_target() {
  echo "$UI_SESSION:0"
}

# Recreate the UI session running the picker so captures always start from list mode.
start_picker() {
  local side="$1"
  local otui_export=""
  if tmux has-session -t "$UI_SESSION" 2>/dev/null; then
    kill_session_if_ours "$UI_SESSION" "$SOCK"
  fi
  if [ "$side" = ts ]; then
    otui_export="export OTUI_ASSET_ROOT=$(cat "$TS_ROOT/otui-asset-root.txt"); "
  fi
  # Isolated env via hsb — sockets never hit live Herdr.
  tmux new-session -d -s "$UI_SESSION" -x "$COLS" -y "$ROWS" -c "$REPO" \
    -e XDG_CONFIG_HOME="$CFG" -e XDG_STATE_HOME="$ROOT/state" -e XDG_BIN_HOME="$BIN" \
    -e HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE" \
    -e HERDR_SOCKET_PATH="$SOCK" -e HERDR_CLIENT_SOCKET_PATH="$CLIENT_SOCK" \
    -e HERDR_PANE_ID= -e HERDR_TAB_ID= -e HERDR_WORKSPACE_ID= -e HERDR_ENV= \
    -e HERDR_CONFIG_PATH= -e HERDR_BIN_PATH= -e HERDR_PLUGIN_CONFIG_DIR= \
    "bash --norc --noprofile -c '${otui_export}exec \"$HSB\" herdr-workflows picker'"
  sleep 1.2
}

wait_picker_hint() {
  local target="$1" needle="$2" i pane
  for i in $(seq 1 30); do
    pane="$(tmux capture-pane -p -t "$target" 2>/dev/null || true)"
    case "$pane" in *"$needle"*) return 0 ;; esac
    sleep 0.25
  done
  echo "timeout waiting for picker hint '$needle' in $target" >&2
  tmux capture-pane -p -t "$target" 2>/dev/null | head -30 >&2
  return 1
}

capture_view() {
  local side="$1" view="$2"
  mkdir -p "$CAPTURE_DIR/$side"
  tmux capture-pane -p -t "$(picker_target)" > "$CAPTURE_DIR/$side/$view.txt"
  echo "$CAPTURE_DIR/$side/$view.txt"
}

drive_and_capture_side() {
  local side="$1"
  paths_for "$side"
  local target
  # Re-seed history each capture pass (realpath checkout_root; safe to overwrite).
  seed_run_history
  target="$(picker_target)"

  start_picker "$side"
  target="$(picker_target)"
  wait_picker_hint "$target" "ctrl+k" || wait_picker_hint "$target" "filter" || true
  capture_view "$side" "workflow-list"

  # Filter: type a short needle (printable keys go to filter in list mode).
  tmux send-keys -t "$target" "br"
  sleep 0.4
  capture_view "$side" "filter"
  # Clear filter with Escape then reopen list focus.
  tmux send-keys -t "$target" Escape || true
  sleep 0.3

  start_picker "$side"
  target="$(picker_target)"
  wait_picker_hint "$target" "ctrl+k" || true
  # Palette: Ctrl+K (not printable k).
  tmux send-keys -t "$target" C-k
  sleep 0.4
  capture_view "$side" "palette"
  tmux send-keys -t "$target" Escape || true
  sleep 0.3

  # Inputs: select branch-check (filtered) and Enter.
  start_picker "$side"
  target="$(picker_target)"
  wait_picker_hint "$target" "ctrl+k" || true
  tmux send-keys -t "$target" "branch"
  sleep 0.4
  tmux send-keys -t "$target" Enter
  sleep 0.6
  capture_view "$side" "inputs"
  tmux send-keys -t "$target" Escape || true
  sleep 0.3

  # Runs list via Tab from workflow list.
  start_picker "$side"
  target="$(picker_target)"
  wait_picker_hint "$target" "ctrl+k" || true
  tmux send-keys -t "$target" Tab
  sleep 0.5
  capture_view "$side" "runs-list"

  # Runs detail: Enter on first row.
  tmux send-keys -t "$target" Enter
  sleep 0.5
  capture_view "$side" "runs-detail"
  tmux send-keys -t "$target" Escape || true
  sleep 0.2
  tmux send-keys -t "$target" Escape || true
  sleep 0.2
}

ensure_ts_worktree() {
  if [ -d "$TS_SRC/.git" ] || [ -f "$TS_SRC/.git" ] || [ -d "$TS_SRC/src" ]; then
    local head
    head="$(git -C "$TS_SRC" rev-parse HEAD 2>/dev/null || true)"
    if [ "$head" = "$TS_SHA" ]; then
      return 0
    fi
    die "TS worktree at $TS_SRC has HEAD ${head:-unknown}, want $TS_SHA — remove it and re-run"
  fi
  if [ -e "$TS_SRC" ]; then
    die "refusing to claim unknown contents at $TS_SRC"
  fi
  git -C "$PLUGIN_ROOT" worktree add --detach "$TS_SRC" "$TS_SHA"
}

up_side() {
  local side="$1"
  paths_for "$side"
  claim_or_reuse "$ROOT" "$TAG" "$SESSION"
  seed_config
  write_wrapper
  seed_repo
  seed_run_history
  if [ "$side" = go ]; then
    build_go_private
  else
    build_ts_private
  fi
  start_server
  setup_plugin_side
  echo "up $side: session=$SESSION sock=$SOCK binary=$BIN/herdr-workflows repo=$REPO"
}

up() {
  assert_not_canonical_sandbox
  command -v herdr >/dev/null || die "herdr binary not on PATH"
  command -v tmux >/dev/null || die "tmux not on PATH"
  command -v go >/dev/null || die "go not on PATH"
  command -v bun >/dev/null || die "bun not on PATH (needed for TS compare worktree only)"
  ensure_ts_worktree
  up_side go
  up_side ts
  status
}

capture_all() {
  assert_not_canonical_sandbox
  paths_for go
  assert_owned "$GO_ROOT" go "$GO_SESSION"
  server_running || die "Go herdr not running"
  paths_for ts
  assert_owned "$TS_ROOT" ts "$TS_SESSION"
  server_running || die "TS herdr not running"
  mkdir -p "$CAPTURE_DIR"
  drive_and_capture_side go
  drive_and_capture_side ts
  write_diff_summary
  echo "captures under $CAPTURE_DIR"
}

write_diff_summary() {
  local out="$CAPTURE_DIR/DIFF_SUMMARY.md"
  {
    echo "# Picker visual compare"
    echo
    echo "- TS SHA: \`$TS_SHA\`"
    echo "- TS worktree: \`$TS_SRC\`"
    echo "- Go herdr/ui/socket: \`$GO_SESSION\` / \`$GO_UI_SESSION\` / \`$GO_ROOT/herdr.sock\`"
    echo "- TS herdr/ui/socket: \`$TS_SESSION\` / \`$TS_UI_SESSION\` / \`$TS_ROOT/herdr.sock\`"
    echo "- Captured: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo
    echo "## File pairs"
    local v
    for v in "${VIEWS[@]}"; do
      echo "- $v: \`$CAPTURE_DIR/go/$v.txt\` vs \`$CAPTURE_DIR/ts/$v.txt\`"
    done
    echo
    echo "## Unified diffs (trimmed)"
    for v in "${VIEWS[@]}"; do
      echo
      echo "### $v"
      echo '```diff'
      if diff -u "$CAPTURE_DIR/ts/$v.txt" "$CAPTURE_DIR/go/$v.txt" 2>/dev/null | head -80; then
        echo "(identical)"
      fi
      echo '```'
    done
  } > "$out"
  echo "$out"
}

down_side() {
  local side="$1"
  paths_for "$side"
  assert_owned "$ROOT" "$TAG" "$SESSION"
  if server_running; then
    isolated herdr server stop >/dev/null 2>&1 || true
  fi
  kill_session_if_ours "$SESSION" "$SOCK"
  if tmux has-session -t "$UI_SESSION" 2>/dev/null; then
    kill_session_if_ours "$UI_SESSION" "$SOCK"
  fi
  rm -rf -- "$ROOT"
  echo "removed $ROOT"
}

down() {
  assert_not_canonical_sandbox
  # Tear down only owned compare roots; never /tmp/hwf-sandbox.
  if [ -e "$GO_ROOT" ]; then down_side go; fi
  if [ -e "$TS_ROOT" ]; then down_side ts; fi
  if [ -d "$CAPTURE_DIR" ]; then
    echo "captures left at $CAPTURE_DIR (delete manually if desired)"
  fi
  echo "TS worktree left at $TS_SRC (git worktree remove when finished)"
}

status() {
  assert_not_canonical_sandbox
  echo "plugin_root: $PLUGIN_ROOT"
  echo "ts_sha:      $TS_SHA"
  echo "ts_src:      $TS_SRC"
  echo "go_root:     $GO_ROOT  herdr=$GO_SESSION ui=$GO_UI_SESSION"
  echo "ts_root:     $TS_ROOT  herdr=$TS_SESSION ui=$TS_UI_SESSION"
  echo "captures:    $CAPTURE_DIR"
  echo "binary note: Go builds to $GO_ROOT/bin/herdr-workflows (checkout bin/ untouched)"
  printf 'go herdr tmux: '; tmux has-session -t "$GO_SESSION" 2>/dev/null && echo yes || echo no
  printf 'go ui tmux:    '; tmux has-session -t "$GO_UI_SESSION" 2>/dev/null && echo yes || echo no
  printf 'ts herdr tmux: '; tmux has-session -t "$TS_SESSION" 2>/dev/null && echo yes || echo no
  printf 'ts ui tmux:    '; tmux has-session -t "$TS_UI_SESSION" 2>/dev/null && echo yes || echo no
  if [ -e "$GO_ROOT" ]; then
    paths_for go
    printf 'go server:     '; server_running && echo running || echo "not running"
  fi
  if [ -e "$TS_ROOT" ]; then
    paths_for ts
    printf 'ts server:     '; server_running && echo running || echo "not running"
  fi
}

usage() {
  cat <<'EOF'
usage: picker-visual-compare.sh [up|capture|down|status|all]

  up       Claim /tmp/hwf-picker-compare-{go,ts}, build private binaries, start Herdr
  capture  Drive picker states and write tmux captures + DIFF_SUMMARY.md
  down     Stop compare Herdr sessions and delete owned sandbox roots
  status   Print paths and liveness
  all      up && capture

Paths never overlap /tmp/hwf-sandbox.
Herdr sessions: hwf-pc-go / hwf-pc-ts. Picker UI sessions: hwf-pc-go-ui / hwf-pc-ts-ui.
EOF
}

assert_not_canonical_sandbox

case "${1:-all}" in
  up) up ;;
  capture) capture_all ;;
  down) down ;;
  status) status ;;
  all) up; capture_all ;;
  *) usage; exit 2 ;;
esac
