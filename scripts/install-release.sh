#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ ! -f herdr-plugin.toml ]; then
  echo "herdr-workflows install-release: herdr-plugin.toml not found in $ROOT" >&2
  exit 1
fi

VERSION=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' herdr-plugin.toml | head -n 1)
if [ -z "$VERSION" ]; then
  echo "herdr-workflows install-release: version missing from herdr-plugin.toml" >&2
  exit 1
fi

UNAME_S=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$UNAME_S" in
  linux) OS=linux ;;
  darwin) OS=darwin ;;
  *)
    echo "herdr-workflows install-release: unsupported OS $UNAME_S (linux and darwin only)" >&2
    exit 1
    ;;
esac

UNAME_M=$(uname -m)
case "$UNAME_M" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)
    echo "herdr-workflows install-release: unsupported arch $UNAME_M (amd64 and arm64 only)" >&2
    exit 1
    ;;
esac

ARCHIVE="herdr-workflows_${VERSION}_${OS}_${ARCH}.tar.gz"
CHECKSUMS=checksums.txt
BASE_URL=${HWF_RELEASE_BASE_URL:-"https://github.com/aorumbayev/herdr-workflows/releases/download/v${VERSION}"}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "herdr-workflows install-release: curl is required" >&2
  exit 1
fi

curl -fsSL "${BASE_URL}/${CHECKSUMS}" -o "${WORK}/${CHECKSUMS}"
curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${WORK}/${ARCHIVE}"

WANT=$(awk -v f="$ARCHIVE" '$2 == f || $2 == ("*" f) { print tolower($1); exit }' "${WORK}/${CHECKSUMS}")
if [ -z "$WANT" ]; then
  echo "herdr-workflows install-release: ${CHECKSUMS} has no entry for ${ARCHIVE}" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  GOT=$(sha256sum "${WORK}/${ARCHIVE}" | awk '{ print tolower($1) }')
elif command -v shasum >/dev/null 2>&1; then
  GOT=$(shasum -a 256 "${WORK}/${ARCHIVE}" | awk '{ print tolower($1) }')
else
  echo "herdr-workflows install-release: sha256sum or shasum is required" >&2
  exit 1
fi

if [ "$GOT" != "$WANT" ]; then
  echo "herdr-workflows install-release: checksum mismatch for ${ARCHIVE}" >&2
  exit 1
fi

mkdir -p "${WORK}/extract" bin
tar -xzf "${WORK}/${ARCHIVE}" -C "${WORK}/extract"
BIN_SRC=$(find "${WORK}/extract" -type f -name herdr-workflows | head -n 1)
if [ -z "$BIN_SRC" ]; then
  echo "herdr-workflows install-release: archive missing herdr-workflows binary" >&2
  exit 1
fi

TMP="bin/.herdr-workflows.$$.tmp"
cp "$BIN_SRC" "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" bin/herdr-workflows
