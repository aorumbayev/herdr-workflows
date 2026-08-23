#!/usr/bin/env sh
# Validate a workflow YAML through hwf's own loader.
# usage: validate.sh <file.yaml> [workflow-name]
# prints {"ok":true} / {"ok":false,"error":...}; exit 0/1/2.
set -eu

file=${1:?usage: validate.sh <file.yaml> [name]}
name=${2:-$(basename "$file" .yaml)}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }

command -v hwf >/dev/null 2>&1 || {
  echo "missing dependency: hwf" >&2
  exit 2
}

set +e
out=$(hwf workflow validate "$file" "$name")
code=$?
set -e
printf '%s\n' "$out"
[ "$code" -eq 0 ] && exit 0
exit 1
