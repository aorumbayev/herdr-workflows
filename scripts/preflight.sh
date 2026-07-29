#!/bin/sh
# Fail before install/build when Bun is missing or older than the documented minimum.
set -eu
MIN_MAJOR=1
MIN_MINOR=3
MIN_LABEL="${MIN_MAJOR}.${MIN_MINOR}"

if ! command -v bun >/dev/null 2>&1; then
  echo "herdr-workflows requires Bun >= ${MIN_LABEL} (bun not found on PATH)" >&2
  exit 1
fi

ver=$(bun --version)
major=${ver%%.*}
rest=${ver#*.}
minor=${rest%%.*}

case "$major$minor" in
  '' | *[!0-9]*)
    echo "herdr-workflows requires Bun >= ${MIN_LABEL} (unparseable version: ${ver})" >&2
    exit 1
    ;;
esac

if [ "$major" -lt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -lt "$MIN_MINOR" ]; }; then
  echo "herdr-workflows requires Bun >= ${MIN_LABEL} (found ${ver})" >&2
  exit 1
fi
