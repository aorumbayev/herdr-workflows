## 1. Run cleanup

- [x] 1.1 In `src/run/runner.ts`, await `finalizeEntryRun` and hold its result, so recovery completes before the `finally` block starts.
- [x] 1.2 Gate managed response removal on that result's `ok`. Keep transcript removal unconditional.

## 2. Coverage

- [x] 2.1 `test/runner.test.ts`: a failed agent step keeps its managed response file and still removes the transcript file.
- [x] 2.2 `test/runner.test.ts`: a successful run removes both.
- [x] 2.3 `test/runner.test.ts`: an `on_failure` step reads the transcript file while it still exists.

## 3. Example

- [x] 3.1 `examples/handoff.yaml`: set `timeout: 30m`, tell the agent to read the transcript first, and write the handoff to a path that outlives the run. Then run `bun run examples`.

## 4. Checks

- [x] 4.1 `bun test ./test`
- [x] 4.2 `CI=1 npm run verify`
- [x] 4.3 `openspec validate --all --strict`
