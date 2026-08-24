## Why

The picker popup works but its actions palette is wordy, the edit action has a
single in-popup path, and a failed run shows a flat line dump that does not
match the rest of the UI. A user needs to tell at a glance why a run failed and
send that failure to an agent to fix the workflow.

## What Changes

- The Ctrl+K actions palette uses one-word labels and hides the actions that
  need a selected workflow.
- The edit action opens a placement chooser: in-popup (default) or an external
  editor pane beside, below, or in a new tab.
- The failed-run detail becomes the console diagram layout: a card rail of
  steps and a right pane showing the cause, exit code, output tail, and step
  source. Opening that detail from the compact Runs list respawns the popup at
  the console size. Escape respawns the compact list. A send-back action ships
  the failure to an agent pane, reusing the console annotation bundle.

## Capabilities

### Modified Capabilities

- `picker-editor-actions`: palette labels, hidden unavailable actions, and the
  edit placement chooser.
- `picker-presentation`: the failed-run detail card rail and its send-back.
- `run-history`: the failure record persists verdict and stream, and detail may
  show a bounded output tail.
- `console-presentation`: the annotation bundle gains an optional failure block.

## Impact

- `internal/picker` (palette, edit action, run detail), `internal/runsbrowser`
  (detail renderer), `internal/console` (shared rail and bundle), `internal/tui`
  (card spec adapter), `internal/workflow` (step source split), `internal/history`
  (FailureFact fields), `internal/host` (editor pane entrypoint).
- Parity rows in `internal/picker/parity.go`, `internal/runsbrowser/parity.go`,
  and `tui.CharmVerdicts`.
