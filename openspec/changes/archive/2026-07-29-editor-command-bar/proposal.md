## Why

The workflow editor spends most of its vertical space on chrome. Around the canvas sit seven stacked bands: the identity row, a `yaml`/`canvas` toggle that wraps into two rows, a full-width `sensitive:` banner, an always-on keyboard hint line, a standalone validity line, the action bar, and a `run in a terminal: hwf run <name>` footer that repeats the command already printed on the trigger node. The controls a user reaches for most — save, undo, mode — are the ones furthest from the graph they are editing, and the canvas gets roughly half the height it could have.

## What Changes

- Collapse the identity row and the action bar into **one command bar**: name, scope and a sensitivity chip on the left; mode toggle, history cluster, unsaved text, `save`, and an overflow `⋯` menu on the right.
- Move `copy`, `download` and `delete` (including its both-scopes variant selector and confirmation) behind the `⋯` menu. Collapse the yaml-mode `append + agent/+ run/+ herdr/+ workflow` row into a single `+ step` menu built from the same helper.
- Replace the full-width `sensitive: …` banner with an inline chip beside the workflow name.
- Drop the standalone `valid` line. Validity becomes a state indicator in the command bar; the existing status line renders only when there is a problem to read, and keeps its jump-to-line behaviour.
- Reduce the canvas to two corner clusters: zoom (`−`, live percentage that resets to 1:1 when activated, `+`) bottom-left; view controls (add step, fit, expand, shortcuts) bottom-right. The floating `+ add step` box in the top-right corner is retired into that cluster.
- Put the keyboard hint text behind the shortcuts toggle instead of printing it over the canvas at all times.
- **Removed:** the `run in a terminal: hwf run <name>` footer. The trigger node caption already states the command, and the canvas is where the user is looking.
- Narrow viewports keep every control: below the bar's wrap width the history cluster folds into the `⋯` menu.
- Make the reclaimed height count: the canvas grows to fill the pane instead of sitting at a fixed `62vh` with dead space beneath it.
- Carry the single-bar layout down to phone widths: list and editor stack in one column, the list becomes a horizontally scrollable strip, the bar breaks between its identity and control groups, and edge-anchored canvas controls respect safe-area insets.
- Add a header control that hides and shows the workflow list, so the editor can have the full width; opening a workflow on a narrow viewport collapses the list automatically.

No capability is removed other than the duplicated footer text. Every action, its accessible name, its keyboard path, and its 32px hit target survive the move.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `web-workbench-presentation`: adds requirements that editor chrome occupies a single command bar with canvas view controls on the canvas, that the keyboard hint is disclosed rather than permanent, that the layout adapts to narrow viewports, and that the workflow list can be collapsed; extends the existing accessible-controls requirement to cover the overflow menu and the validity indicator.
- `web-workbench-editing`: the unsaved indicator, save, and the destructive actions are specified by placement-independent behaviour today, so only the delete/copy/download presentation requirement changes — the actions now live in an overflow menu that MUST stay keyboard reachable and MUST keep the delete confirmation.

## Impact

- `src/web/page.html` — editor pane assembly (`bar1`/`bar2`/`flagBox`/`status`/`foot`), `makeCanvas` zoombar, `addnode` and `tip` elements, plus the `.bar`, `.flags`, `.zoombar`, `.addnode`, `.tip` and `.hint` rules. One new shared menu helper, one header list control, and the narrow-viewport rules.
- `test/web-presentation.test.ts` — assertions covering the retired footer, the hint line, and the new bar/menu structure.
- No server, loader, schema, or CLI change. No new dependency.
