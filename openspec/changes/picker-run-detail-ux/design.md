## Context

The picker popup already respawns per-tab geometry (compact for workflows and
runs, large for console). The console diagram already draws a kind-colored card
rail plus a detail pane, and its send-back types an annotation bundle into an
agent pane. The runs detail still renders as a flat ordered line dump with no
failure prominence.

## Goals / Non-Goals

**Goals:**

- One-word palette labels. Hide edit, share, and delete without a selection.
- An edit placement chooser with an in-popup default and external editor panes.
- A failed-run detail that reuses the console rail and shows the cause, exit
  code, output tail, and step source.
- A send-back from the failed-run detail that reuses the console bundle.
- Run detail respawns the popup at the console size. Escape respawns compact.

**Non-Goals:**

- Per-step stdout/stderr persistence beyond the 500-byte tail.
- Per-step transcripts and durations.
- Retrying a step from the pane.
- A log/transcript/yaml tab set in the picker.
- Auto-generated fix hints.

## Decisions

- Move `railCard`, `railSplit`, `renderRailYAML`, and the card helpers from
  `internal/console/rail.go` into `internal/tui` as a `CardSpec{Kind, Title,
  Body, Focused, Selected, Muted}`. The console maps `DiagramNode` to
  `CardSpec`. The runs browser maps `StepRecord` to `CardSpec`. This removes the
  console-to-runsbrowser import cycle.
- Move `splitStepYAML` and `colorYAML` so both surfaces read step source the
  same way.
- The edit placement chooser reuses `plugin.pane.open` with a new `editor`
  entrypoint. External panes close on editor exit. The picker does not reopen.
  In-popup editing keeps the existing `tea.ExecProcess` path. The compact
  popup has no room for `$EDITOR`, so the picker respawns at the console size
  with the file in the popup state, runs the editor there, and respawns compact
  after validation.
- `history.FailureFact` gains optional `Verdict` and `Stream` fields read from
  the existing capture details, backward-compatible with snapshot version 1.
- The failure detail's right pane shows: header, cause line per action kind,
  command and exit code, a 500-byte output tail, and the step source with a
  fallback sentence.
- The output tail is local-only: it renders in the detail pane but is excluded
  from the send-back bundle. Shipping raw output to an agent pane can leak
  secrets from the captured stream, so the bundle carries cause, exit code, and
  step source instead.
- Run detail reuses the edit-placement respawn. `PopupState` carries the selected
  run id and a detail marker. The compact list stays `64` by `15`. Entering
  detail stamps `85%` by `80%`. `needsRespawn` stops a second respawn at that
  size. Escape stamps the compact Runs list.

## Risks / Trade-offs

- Moving the rail into `tui` touches the console diagram and needs the
  `DiagramNode` to `CardSpec` mapping to stay byte-identical on the happy path.
- The output tail reuses the bounded explanation rather than a new capture
  pipeline. It shows at most 500 bytes, so large outputs are truncated by
  design.
- External editor panes add a plugin entrypoint. The pane lifecycle is
  fire-and-forget from the picker, so a failed editor launch surfaces through a
  notification, not picker status.
