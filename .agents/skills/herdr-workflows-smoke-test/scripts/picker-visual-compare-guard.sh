#!/usr/bin/env bash
# Guard checks for picker-visual-compare.sh path/session isolation.
# Does not start Herdr. Run: bash scripts/picker-visual-compare-guard.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$ROOT/picker-visual-compare.sh"
failed=0

expect_refuse() {
  local label="$1"
  shift
  local err
  if err="$("$@" 2>&1)"; then
    echo "fail: $label unexpectedly succeeded" >&2
    failed=1
  elif printf '%s' "$err" | grep -Eq 'refusing|overlap|canonical|must differ'; then
    echo "ok: $label refused"
  else
    echo "fail: $label unexpected error: $err" >&2
    failed=1
  fi
}

# Overlap with canonical smoke sandbox must refuse.
expect_refuse "go root overlaps hwf-sandbox" \
  env HWF_PC_GO_ROOT=/tmp/hwf-sandbox HWF_PC_TS_ROOT=/tmp/hwf-picker-compare-ts \
  bash "$SCRIPT" status

expect_refuse "ts root overlaps hwf-sandbox" \
  env HWF_PC_GO_ROOT=/tmp/hwf-picker-compare-go HWF_PC_TS_ROOT=/tmp/hwf-sandbox \
  bash "$SCRIPT" status

expect_refuse "session name hwf-sandbox" \
  env HWF_PC_GO_SESSION=hwf-sandbox HWF_PC_TS_SESSION=hwf-pc-ts \
  bash "$SCRIPT" status

expect_refuse "identical session names" \
  env HWF_PC_GO_SESSION=hwf-pc-same HWF_PC_TS_SESSION=hwf-pc-same \
  bash "$SCRIPT" status

expect_refuse "herdr and ui session collide" \
  env HWF_PC_GO_SESSION=hwf-pc-go HWF_PC_GO_UI_SESSION=hwf-pc-go \
  bash "$SCRIPT" status

# Default status must accept distinct compare paths (no Herdr required).
if out="$(bash "$SCRIPT" status 2>&1)"; then
  ok=1
  for needle in hwf-pc-go hwf-pc-ts hwf-pc-go-ui hwf-pc-ts-ui; do
    case "$out" in
      *"$needle"*) ;;
      *)
        echo "fail: default status missing $needle: $out" >&2
        ok=0
        failed=1
        ;;
    esac
  done
  [ "$ok" -eq 1 ] && echo "ok: default status paths"
else
  echo "fail: default status exited non-zero: $out" >&2
  failed=1
fi

# Canonical sandbox.sh path guard still intact (must not be weakened by this skill).
if err="$(HWF_SANDBOX=/tmp/elsewhere bash "$ROOT/sandbox.sh" status 2>&1)"; then
  echo "fail: sandbox.sh accepted non-canonical path" >&2
  failed=1
elif printf '%s' "$err" | grep -q 'refusing sandbox path outside canonical'; then
  echo "ok: sandbox.sh canonical path guard intact"
else
  echo "fail: sandbox.sh unexpected: $err" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "picker-visual-compare-guard passed"
