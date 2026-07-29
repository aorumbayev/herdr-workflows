#!/bin/sh
# Clean agent side effects between eval runs; keep the child workflow the tasks may compose with.
S=$(cd "$(dirname "$0")" && pwd)
for v in v1 v2; do
  find "$S/fixtures/$v/.hwf/workflows" -name '*.yaml' ! -name 'child-verify.yaml' -delete 2>/dev/null
  rm -rf "$S/fixtures/$v/.hwf/tmp"
done
pkill -f 'hwf web' 2>/dev/null
rm -f /tmp/draft.yaml
exit 0
