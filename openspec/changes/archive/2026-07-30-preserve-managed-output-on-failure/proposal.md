## Why

Run cleanup destroys work that a live agent produced.

`runWorkflow` ends with an unconditional `finally` that removes the transcript file and every managed response file. Two defects follow.

The cleanup removes managed response files even when the run failed, and a failed wait leaves the agent still working. The agent then writes to a deleted path, or the runner deletes what it wrote. The user loses the turn with no artifact. The `handoff` example shows the cost: the handoff text was written, deleted, and never read.

`runWorkflow` also returns `finalizeEntryRun(...)` without awaiting it, so cleanup can remove the transcript file while `on_failure` recovery still reads it.

## What Changes

- Remove managed response files only when the run succeeds. A failed or aborted run leaves them in `.hwf/tmp/`, which `ensureLocalConfigGitignored` already keeps out of Git.
- Await `finalizeEntryRun` so recovery completes before cleanup starts. The transcript file stays readable for the whole `on_failure` step.
- Keep removing the transcript file on every path, success or failure.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `workflow-grammar`: **Requirement: Canonical invocation context** gains the cleanup ordering rule and the managed-response retention rule. The transcript removal rule is unchanged.

## Impact

- `src/run/runner.ts` — `runWorkflow` tracks the finalized outcome and gates managed-response removal on it. One `await` added.
- `test/runner.test.ts` — coverage for a failed run keeping its managed response, a successful run removing it, and recovery reading the transcript before cleanup.
- No loader, schema, CLI, or dependency change.

One adjacent fix rides in the same branch and needs no spec delta, because it changes no runtime behavior. `examples/handoff.yaml` sets `timeout: 30m`, matching the documented default instead of halving it to `15m`. The old value made the timeout fire on the one step that must read a whole session transcript. The same example now tells the agent to read the transcript first and to write the handoff where it outlives the run, and `docs/.vitepress/theme/examples.generated.ts` is regenerated with `bun run examples`.
