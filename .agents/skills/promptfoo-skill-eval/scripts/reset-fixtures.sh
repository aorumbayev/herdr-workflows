#!/bin/sh
# Clean agent side effects between eval runs inside an owned skill-eval scratchpad.
# Does not kill processes and does not touch shared /tmp paths.
#
# Supported maintainer invocation (from the eval root that holds fixtures/):
#   root=$(git rev-parse --show-toplevel)
#   cd <scratchpad>/skill-eval
#   sh "$root/.agents/skills/promptfoo-skill-eval/scripts/reset-fixtures.sh"
#
# Optional: pass the eval root explicitly:
#   sh .../reset-fixtures.sh /path/to/skill-eval
#
# Dry-run ownership and symlink guards (no deletion):
#   sh .../reset-fixtures.sh --guard-check [/path/to/skill-eval]
#
# Ownership: eval root must contain `.promptfoo-skill-eval-owned` with:
#   promptfoo-skill-eval
#   skill_root=<absolute path to .agents/skills/promptfoo-skill-eval>
# Seed that marker when creating the scratchpad (see SKILL.md). Never run against
# a directory that lacks it — cleanup refuses unknown trees.
set -eu

SKILL_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
MODE=reset
EVAL_ARG=.
for arg in "$@"; do
  case "$arg" in
    --guard-check) MODE=guard-check ;;
    *) EVAL_ARG=$arg ;;
  esac
done
EVAL_ROOT=$(CDPATH='' cd -- "$EVAL_ARG" && pwd)
MARKER_NAME=".promptfoo-skill-eval-owned"
MARKER="$EVAL_ROOT/$MARKER_NAME"

# Refuse when any path component from $1 down to $2 is a symlink.
# Ancestors above the owned root are ignored (macOS /var → /private/var).
assert_no_symlink_under() {
  base=$1
  target=$2
  case "$target" in
    "$base"|"$base"/*) ;;
    *)
      echo "refusing: cleanup path not under owned root: $target" >&2
      exit 2
      ;;
  esac
  if [ -L "$base" ]; then
    echo "refusing: symlink in cleanup path component: $base" >&2
    exit 2
  fi
  if [ "$target" = "$base" ]; then
    return 0
  fi
  rel=${target#"$base"/}
  cur=$base
  old_ifs=$IFS
  IFS=/
  # shellcheck disable=SC2086
  set -- $rel
  IFS=$old_ifs
  for part in "$@"; do
    [ -n "$part" ] || continue
    cur="$cur/$part"
    if [ -L "$cur" ]; then
      echo "refusing: symlink in cleanup path component: $cur" >&2
      exit 2
    fi
  done
}

assert_under_eval_root() {
  target=$1
  real_eval=$(CDPATH='' cd -- "$EVAL_ROOT" && pwd -P)
  real_target=$(CDPATH='' cd -- "$target" && pwd -P)
  case "$real_target" in
    "$real_eval"|"$real_eval"/*) ;;
    *)
      echo "refusing: cleanup target escapes owned eval root: $target" >&2
      exit 2
      ;;
  esac
}

assert_owned_eval_root() {
  if [ ! -f "$MARKER" ]; then
    echo "refusing: missing ownership marker $MARKER" >&2
    echo "seed the scratchpad marker before reset (see promptfoo-skill-eval SKILL.md)" >&2
    exit 2
  fi
  if [ -L "$MARKER" ] || [ -L "$EVAL_ROOT" ]; then
    echo "refusing: ownership marker or eval root is a symlink" >&2
    exit 2
  fi
  assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT"
  if ! grep -Fqx 'promptfoo-skill-eval' "$MARKER"; then
    echo "refusing: marker does not claim promptfoo-skill-eval ownership" >&2
    exit 2
  fi
  if ! grep -Fqx "skill_root=$SKILL_ROOT" "$MARKER"; then
    echo "refusing: marker skill_root mismatch (want skill_root=$SKILL_ROOT)" >&2
    exit 2
  fi
  if [ ! -d "$EVAL_ROOT/fixtures/v1" ] || [ ! -d "$EVAL_ROOT/fixtures/v2" ]; then
    echo "refusing: expected fixtures/v1 and fixtures/v2 under $EVAL_ROOT" >&2
    exit 2
  fi
  assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT/fixtures/v1"
  assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT/fixtures/v2"
  assert_under_eval_root "$EVAL_ROOT/fixtures/v1"
  assert_under_eval_root "$EVAL_ROOT/fixtures/v2"
}

guard_check() {
  failed=0
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/promptfoo-skill-eval-guard.XXXXXX")
  cleanup_guard() { rm -rf -- "$tmp"; }
  trap cleanup_guard EXIT

  # 1) Missing marker → refuse.
  mkdir -p "$tmp/no-marker/fixtures/v1" "$tmp/no-marker/fixtures/v2"
  if (
    EVAL_ROOT="$tmp/no-marker"
    MARKER="$EVAL_ROOT/$MARKER_NAME"
    assert_owned_eval_root
  ) 2>"$tmp/no-marker.err"; then
    echo "guard-check fail: missing marker unexpectedly accepted" >&2
    failed=1
  elif grep -Fq 'missing ownership marker' "$tmp/no-marker.err"; then
    echo "guard-check ok: missing marker refused"
  else
    echo "guard-check fail: unexpected missing-marker error: $(cat "$tmp/no-marker.err")" >&2
    failed=1
  fi

  # 2) Intermediate .hwf symlink under fixtures → refuse.
  mkdir -p "$tmp/link-eval/fixtures/v1" "$tmp/link-eval/fixtures/v2" "$tmp/outside"
  printf 'promptfoo-skill-eval\nskill_root=%s\n' "$SKILL_ROOT" >"$tmp/link-eval/$MARKER_NAME"
  ln -s "$tmp/outside" "$tmp/link-eval/fixtures/v1/.hwf"
  mkdir -p "$tmp/link-eval/fixtures/v2/.hwf/workflows"
  if (
    EVAL_ROOT=$(CDPATH='' cd -- "$tmp/link-eval" && pwd)
    MARKER="$EVAL_ROOT/$MARKER_NAME"
    assert_owned_eval_root
    assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT/fixtures/v1/.hwf"
  ) 2>"$tmp/link.err"; then
    echo "guard-check fail: intermediate .hwf symlink unexpectedly accepted" >&2
    failed=1
  elif grep -Fq 'symlink in cleanup path component' "$tmp/link.err"; then
    echo "guard-check ok: intermediate .hwf symlink refused"
  else
    echo "guard-check fail: unexpected symlink error: $(cat "$tmp/link.err")" >&2
    failed=1
  fi

  # 3) Complete owned tree → accepted.
  mkdir -p "$tmp/good/fixtures/v1/.hwf/workflows" "$tmp/good/fixtures/v2/.hwf/workflows"
  printf 'promptfoo-skill-eval\nskill_root=%s\n' "$SKILL_ROOT" >"$tmp/good/$MARKER_NAME"
  if (
    EVAL_ROOT=$(CDPATH='' cd -- "$tmp/good" && pwd)
    MARKER="$EVAL_ROOT/$MARKER_NAME"
    assert_owned_eval_root
    assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT/fixtures/v1/.hwf"
    assert_no_symlink_under "$EVAL_ROOT" "$EVAL_ROOT/fixtures/v2/.hwf"
  ) 2>"$tmp/good.err"; then
    echo "guard-check ok: complete owned tree accepted"
  else
    echo "guard-check fail: complete tree rejected: $(cat "$tmp/good.err")" >&2
    failed=1
  fi

  trap - EXIT
  cleanup_guard
  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
  echo "guard-check passed"
}

if [ "$MODE" = "guard-check" ]; then
  if [ "$EVAL_ARG" != "." ] && [ -d "$EVAL_ARG" ]; then
    assert_owned_eval_root
  fi
  guard_check
  exit 0
fi

assert_owned_eval_root

for v in v1 v2; do
  base="$EVAL_ROOT/fixtures/$v"
  assert_no_symlink_under "$EVAL_ROOT" "$base"
  assert_under_eval_root "$base"
  if [ -e "$base/.hwf" ]; then
    assert_no_symlink_under "$EVAL_ROOT" "$base/.hwf"
    assert_under_eval_root "$base/.hwf"
  fi
  if [ -d "$base/.hwf/workflows" ]; then
    assert_no_symlink_under "$EVAL_ROOT" "$base/.hwf/workflows"
    assert_under_eval_root "$base/.hwf/workflows"
    find "$base/.hwf/workflows" -name '*.yaml' ! -name 'child-verify.yaml' -delete
  fi
  if [ -d "$base/.hwf/tmp" ]; then
    assert_no_symlink_under "$EVAL_ROOT" "$base/.hwf/tmp"
    assert_under_eval_root "$base/.hwf/tmp"
    rm -rf -- "$base/.hwf/tmp"
  fi
done

exit 0
