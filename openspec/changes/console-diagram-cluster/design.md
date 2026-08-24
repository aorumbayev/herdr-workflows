## Context

The throwaway prototype at `prototype/console-diagram` @ `7b64fa15` proved the card-rail layout, connector math, YAML colorizer, and kind colors. Production spends `tui.Theme` instead of a local ANSI table. Send-back already types into an existing agent pane. The console must not grow a YAML writer.

## Goals / Non-Goals

**Goals:**

- `Master-detail` card rail plus always-visible raw YAML in popup tab and popped-out pane
- Send-back upgraded in place: file path, focus ids, anchor kind, skill pointer, instruction
- Shared file watch with last-good diagram on loader failure
- Mouse navigation with keyboard twins. `a` / `d` seed the composer
- Mouse reporting enabled in both hosts

**Non-Goals:**

- Console-owned YAML mutation
- Drag reorder
- New send-back mode or confirm-bar
- Shared hit-zone library with herdr-canvas
- New workflow grammar

## Decisions

1. **Layout math comes from the prototype.** Left rail ~34 columns (shrink when width < 50). Cards use kind-colored box borders with `[ kind ]` in the top strip. Connectors are centered muted `│` plus `▼`. The YAML pane is the remaining width. Scroll the rail into view around focus. Show `... N above/below` when windowed.
2. **Kind colors are `tui.Theme`.** `Theme.KindStyle(kind)` maps agent/run/herdr/workflow onto the existing indexed slots. YAML highlighting uses those slots: keys agent, quoted strings run, `{{templates}}` herdr, bare scalars warn, comments muted.
3. **Labels live in `ProjectDiagram`.** Fill `Label` for run argv (joined, 24 cells, argv form only) and agent prompt first non-empty line (24 cells). Herdr method and child workflow name already fill `Label`. Shell-form `run:` stays empty so the rail falls back to `step N`. Derived titles that are not declared ids get a muted `·N` suffix.
4. **Raw YAML is the file, split by list items.** The detail pane shows the selected step's source chunk from the workflow file, not a re-serialized node. Missing file falls back to `StepYAMLFragments` for display only. The send-back bundle never includes those fragments.
5. **Watch is poll-based.** `tea.Tick` every 400ms stats the workflow file. No `fsnotify`. Shared console infrastructure, not refine-only. On parse success, swap the diagram and re-resolve selection by declared id. On parse failure, keep last-good diagram, set status to the loader error, keep scroll.
6. **Selection model.** The cursor steps card to card. Connectors are decoration with no cursor stop and no hit zone. Multi-select is a set of declared ids. Empty set plus card/workflow send-back means the whole file. Card send-back carries `{step: id}`, a seeded insert carries `before`/`after` that card. Positional `step N` drops on reload.
7. **`a` / `d` seed the existing composer.** `a` asks before or after the focused card in a two-option keyboard-first prompt, then prefills an insert instruction. `d` prefills a delete instruction for the focused card. Enter still sends. Esc still cancels. No silent canned send.
8. **Mouse reporting.** Standalone `hwf console` sets `View.MouseMode = MouseModeAllMotion`. The picker already does. The picker forwards `click` and wheel into the embedded console with Y shifted by the tab bar. `Ctrl+click` uses `tea.ModCtrl`.
9. **Charm re-judgement.** Keep custom rail and hit zones. Re-judge `runs-detail-scroll`: product now consumes wheel on the diagram without importing `bubbles` viewport. Add `console-hit-zones` and `console-mouse-reporting`.

## Risks / Trade-offs

- Polling can miss sub-interval saves. 400ms is enough for agent edits and `$EDITOR` writes.
- Unicode box drawing is outside `ChromeStrings`. The prototype already used it. ASCII chrome tests stay on `ChromeStrings`.
- Popup send-back still types into a live agent pane. The modal popup cannot host the refine loop. That is issue 47, unchanged.

## Migration Plan

No user migration. Existing workflows keep their YAML. Operators see a new diagram chrome.

## Open Questions

None. Unspecified calls below are recorded in the implementation report.
