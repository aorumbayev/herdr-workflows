# Proposal: surface-read-truncation

## Why

herdr 0.8.0 sets `read.truncated: true` on pane and agent read results when older scrollback rows were omitted. The plugin passed that partial text through as an ordinary success, so a workflow author and the run-history inspector could not tell a complete capture from a truncated one.

## What Changes

- A successful `herdr:` action whose result reports omitted older rows (`read.truncated: true`) marks its step outcome truncated. The step does not fail and the captured result is unchanged.
- A placed `ready_when:` run whose readiness read reports omitted older rows marks its step outcome the same way.
- The run-history snapshot persists `truncated: true` on that step record, and detail projection presents the flag with the step outcome.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `herdr-primitives`: success results that report read truncation mark the step outcome truncated without failing the step.
- `run-history`: step records persist the truncation fact and detail projection surfaces it.

## Impact

- `src/engine.ts`: step outcome gains an optional truncated flag on the `herdr:` and placed-readiness success paths.
- `src/history.ts`: step record schema, recorder persistence, and detail presentation carry the flag.
