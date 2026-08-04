# Tasks: surface-read-truncation

Run `bun test ./test` and `CI=1 npm run verify` after every task.

- [x] 1.1 Mark the step outcome truncated when a `herdr:` success result or a placed readiness read reports `read.truncated: true` (`src/engine.ts`). The step still succeeds and the captured result is unchanged.
- [x] 1.2 Persist `truncated: true` on the run-history step record and present it in detail projection (`src/history.ts`).
- [x] 1.3 Add engine and history tests: truncated read records the flag, non-truncated read omits it, detail presentation shows it.
