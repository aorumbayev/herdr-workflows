## Why

A live run of the 85% by 80% popup found five faults the visual pass left behind. The workflow list still draws six rows at any popup height, so most of the popup is empty. The embedded console draws one row more than the popup holds, so its footer falls off the bottom. The diagram gives no mark and no reason when a step declares no id, the send-back composer names its own mechanism instead of the task and hides a draft wider than one row, the actions palette skips the chrome every other screen uses, and the console tab opens a second copy of the workflow list the picker already shows.

A second live run added three more: the popup is one size for every tab, the frame blinks when a status line appears, and the rail stops on the empty space between cards.

## What Changes

- Add `tui.FitViewport`. The picker workflow list, the runs list, and the run detail body fill their host above the six-row and ten-row floors. This replaces the fixed six-row viewport the picker spec locked for the old 64 by 15 popup.
- Subtract the tab bar row before the picker hands a size to an embedded browser, so the console tab frame fits the popup.
- Keep a selection mark slot on every diagram card. A step without a declared id shows an unavailable mark, and `v` or `ctrl+click` on it says why. Selection still anchors only on declared ids.
- The send-back composer states that an agent pane will edit the workflow file, names the file, the anchor, and the focus steps from the same helper the bundle uses, and wraps the draft per line.
- The actions palette draws its rows through the shared list row, mutes the actions the selection cannot fire, and closes with the rule and the muted footer.
- Give each root tab the popup size it needs. The manifest opens compact at 64 by 15 for the Workflow and Runs browsers. A switch to the Console browser carries the tab, filter, cursor, and offset into a detached reopen at 85% by 80%, because herdr cannot resize a live popup. A same-size switch stays in place.
- Reserve the list status row. A frame that changes its line count makes the inline renderer erase and redraw the whole frame, which is the blink the live run saw.
- Drop gap selection. The rail steps card to card, connectors carry no cursor stop and no hit zone, and `a` asks whether the new step goes before or after the focused card.
- The picker console tab opens the diagram of the selected workflow. `esc` and `tab` on that diagram return to the workflows tab. The console keeps its own list for the standalone pane.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `picker-presentation`: list viewport fills the popup above a six-row floor
- `picker-editor-actions`: the actions palette draws with the shared list chrome
- `picker-presentation`: popup geometry follows the active root tab, and the reworded requirement lands on the unarchived `picker-popup-ux` delta
- `picker-popup-ux` and `console-diagram-cluster` are unarchived, so the console tab entry, the card mark slot, and the composer wording ride as edits to those deltas rather than as a second modification of the same requirements

## Impact

- **Code:** `internal/tui` FitViewport, `internal/picker` viewport, tab body height, console tab entry, palette, `internal/runsbrowser` viewport, `internal/console` card mark, composer, `OpenDiagram`
- **Tests:** viewport growth, popup frame height, id-less card mark, composer anchor and wrap, palette chrome, console tab diagram entry, parity rows
- **Gates:** `go tool verify`, `openspec validate --all --strict`
- **Out of scope:** removing the console tab, a scroll thumb, a bubbles list or viewport, drag-reorder, a console YAML writer, an upstream popup resize
