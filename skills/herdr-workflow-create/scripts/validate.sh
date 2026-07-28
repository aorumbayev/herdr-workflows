#!/usr/bin/env sh
# Validate a workflow YAML through hwf's own loader.
# usage: validate.sh <file.yaml> [workflow-name]
# prints {"ok":true} / {"ok":false,"error":…}; exit 0 = valid, 1 = invalid, 2 = cannot check.
set -eu

file=${1:?usage: validate.sh <file.yaml> [name]}
name=${2:-$(basename "$file" .yaml)}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }

missing=""
command -v hwf >/dev/null 2>&1 || missing="${missing} hwf"
command -v curl >/dev/null 2>&1 || missing="${missing} curl"
command -v python3 >/dev/null 2>&1 || missing="${missing} python3"
if [ -n "$missing" ]; then
  echo "missing dependency:${missing}" >&2
  exit 2
fi

log=$(mktemp)
http_tmp=""
pid=""
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$log"
  [ -n "$http_tmp" ] && rm -f "$http_tmp"
}
on_signal() {
  cleanup
  trap - EXIT
  exit 2
}
trap cleanup EXIT
trap on_signal INT TERM

# `hwf web` picks a free port itself and prints "… · http://127.0.0.1:<port>/?token=<uuid>".
hwf web --no-open >"$log" 2>&1 &
pid=$!

token=""
i=0
while [ "$i" -lt 100 ]; do
  token=$(sed -n 's/.*token=//p' "$log" | tr -d '\r' | head -n 1)
  [ -n "$token" ] && break
  kill -0 "$pid" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.1
done
if [ -z "$token" ]; then
  echo "hwf web did not start: $(cat "$log")" >&2
  exit 2
fi
base=$(sed -n 's|.*· \(http://[^?]*\).*|\1|p' "$log" | tr -d '\r' | head -n 1)
if [ -z "$base" ]; then
  echo "hwf web printed no base URL: $(cat "$log")" >&2
  exit 2
fi

body=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "text": open(sys.argv[2]).read()}))' "$name" "$file") || {
  echo "failed to encode validate body" >&2
  exit 2
}

http_tmp=$(mktemp)
set +e
http_code=$(printf '%s' "$body" | curl -sS -o "$http_tmp" -w '%{http_code}' -X POST "${base}api/validate" \
  -H "x-hwf-token: $token" -H 'content-type: application/json' --data-binary @-)
curl_status=$?
set -e
if [ "$curl_status" -ne 0 ]; then
  echo "curl failed talking to ${base}api/validate (exit $curl_status)" >&2
  exit 2
fi
out=$(cat "$http_tmp")
echo "$out"

case "$http_code" in
  200 | 400) ;;
  *)
    echo "validate HTTP $http_code" >&2
    exit 2
    ;;
esac

ok=$(printf '%s' "$out" | python3 -c 'import json,sys
try:
  data=json.load(sys.stdin)
except Exception:
  print("invalid", file=sys.stderr)
  sys.exit(2)
print("true" if data.get("ok") is True else "false")') || exit 2

[ "$ok" = "true" ] && exit 0
exit 1
