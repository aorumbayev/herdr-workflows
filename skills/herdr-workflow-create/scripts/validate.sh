#!/usr/bin/env sh
# Validate a workflow YAML through hwf's own loader.
# usage: validate.sh <file.yaml> [workflow-name]
# prints {"ok":true} / {"ok":false,"error":…}; exit 0 = valid, 1 = invalid, 2 = cannot check.
set -eu

file=${1:?usage: validate.sh <file.yaml> [name]}
name=${2:-$(basename "$file" .yaml)}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
command -v hwf >/dev/null 2>&1 || { echo "hwf not on PATH — install the herdr-workflows plugin" >&2; exit 2; }

log=$(mktemp)
# `hwf web` picks a free port itself and prints "… · http://127.0.0.1:<port>/?token=<uuid>".
hwf web --no-open >"$log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; rm -f "$log"; }
trap cleanup EXIT INT TERM

token=""
i=0
while [ "$i" -lt 100 ]; do
  token=$(sed -n 's/.*token=//p' "$log")
  [ -n "$token" ] && break
  kill -0 "$pid" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.1
done
if [ -z "$token" ]; then
  echo "hwf web did not start: $(cat "$log")" >&2
  exit 2
fi
base=$(sed -n 's|.*· \(http://[^?]*\).*|\1|p' "$log")

body=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "text": open(sys.argv[2]).read()}))' "$name" "$file")
out=$(printf '%s' "$body" | curl -sS -X POST "${base}api/validate" \
  -H "x-hwf-token: $token" -H 'content-type: application/json' --data-binary @-)
echo "$out"

case "$out" in
  *'"ok":true'*) exit 0 ;;
  *) exit 1 ;;
esac
