#!/bin/sh
# Fail before install/build when Go is missing or older than go.mod requires.
set -eu
MIN_MAJOR=1
MIN_MINOR=27
MIN_LABEL="${MIN_MAJOR}.${MIN_MINOR}"

if ! command -v go >/dev/null 2>&1; then
  echo "herdr-workflows requires Go >= ${MIN_LABEL} (go not found on PATH)" >&2
  exit 1
fi

line=$(go version 2>/dev/null || true)
case "$line" in
  "go version go"[0-9]*)
    ver=${line#go version go}
    ver=${ver%% *}
    major=${ver%%.*}
    rest=${ver#*.}
    minor=${rest%%.*}
    ;;
  *)
    echo "herdr-workflows requires Go >= ${MIN_LABEL} (unparseable version: ${line})" >&2
    exit 1
    ;;
esac

case "$major$minor" in
  '' | *[!0-9]*)
    echo "herdr-workflows requires Go >= ${MIN_LABEL} (unparseable version: ${line})" >&2
    exit 1
    ;;
esac

if [ "$major" -lt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -lt "$MIN_MINOR" ]; }; then
  echo "herdr-workflows requires Go >= ${MIN_LABEL} (found ${ver})" >&2
  exit 1
fi
