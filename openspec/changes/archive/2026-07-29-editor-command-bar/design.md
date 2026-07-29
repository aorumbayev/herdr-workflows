## Context

The editor pane in `src/web/page.html` assembles seven children in `renderWorkflow`:

```js
pane.append(bar1, flagBox, ed.wrap, canvasHost, status, bar2, foot);
```

`bar1` holds the name input, the scope select, the mode segment, and `addbar` (a `append` caption plus one `+ <verb>` button per verb, yaml mode only). `bar2` holds undo, redo, the unsaved text, save, copy, download, delete, and — when the name exists in both scopes — a scope select in front of delete. `flagBox` is a full-width sensitivity banner, `status` is a validity line that also carries loader errors and a jump-to-line click, and `foot` restates `hwf run <name>`, which `setFoot` also writes into the canvas trigger caption.

Inside `makeCanvas`, the canvas root carries a five-button `zoombar` bottom-left (`−`, `+`, fit, expand, `1:1`), an `addnode` button floating top-right, and a `tip` span bottom-right printing six shortcuts permanently.

Constraints that shape the work: `verify:hardcoded-colors` rejects any colour literal outside the two token blocks; `test/web-presentation.test.ts` greps the served page for control names, `aria-label`s, and the `min-height: 32px` rules; `verify:duplicate-code` and `verify:unused-code` both run in the pre-commit gate; and `web-workbench-editing` already requires every canvas editing control to survive canvas expansion, which is a `position: fixed; inset: 0` overlay — anything left in the pane bar is unreachable while expanded.

## Goals / Non-Goals

**Goals:**

- One bar of document chrome; the canvas gets the reclaimed height.
- Canvas-space controls on the canvas, in two clusters, so expansion keeps them all.
- Every existing action keeps its behaviour, accessible name, keyboard path, and 32px hit target.
- Net deletion in `page.html`, not net addition.

**Non-Goals:**

- No change to the app header, the sidebar, the config pane, or the share/import panes.
- No new keyboard shortcuts, no shortcut remapping, and no persistence of the shortcuts-help state.
- No visual redesign of nodes, edges, ports, or the node detail view.
- No new dependency and no build-step change.

## Decisions

**One `.bar` for both halves, `margin-left: auto` for the split.** `bar1` becomes the single bar and `bar2` is deleted; the trailing group starts with a spacer element rather than being a nested flex container, so the existing `.bar { flex-wrap: wrap }` still degrades correctly on narrow viewports instead of overflowing. Alternative considered: `justify-content: space-between` on two nested groups — rejected because nested wrapping produces a ragged two-row bar at intermediate widths.

**One `mkMenu(label, items)` helper, used twice.** The overflow menu (`⋯` → copy, download, delete) and the yaml-mode append menu (`+ step` → one item per verb) are the same widget: a button with `aria-haspopup="menu"` / `aria-expanded`, a `role="menu"` popover of `role="menuitem"` buttons, Escape and outside-click to close, focus returned to the trigger. Writing it twice would fail `verify:duplicate-code`; writing it as one helper is also the smaller diff, since it replaces five loose buttons. Delete's both-scopes case becomes three menu items (local, global, both) instead of a select plus a button, which removes the only select-inside-a-button-row in the editor.

**Validity becomes a state chip plus the existing status line, shown only when there is something to read.** The `valid` string stops being rendered; `setStatus` keeps writing failures into `status`, and `.status:empty { display: none }` collapses the band when there is nothing to say. This satisfies the modified presentation requirement (text, not colour alone) without putting multi-line loader errors inside a flex bar, and keeps the jump-to-line affordance untouched. Alternative considered: a tooltip on a red dot — rejected, it hides error text behind hover.

**Sensitivity becomes a chip in the bar.** `paintFlags` keeps its current input and its `hide` toggle; only the element's class and position change. The `.flags` rule is replaced by a `.chip` rule reusing `--yellow` through the existing `.warn` token path, so no new colour token is introduced.

**Add step moves into the canvas view cluster instead of being deleted.** The design review proposed dropping it because the inter-node `+` ports and the empty-state button already add steps. Those ports are 14px, below the 32px floor the presentation spec sets for interactive elements, and there is no keyboard shortcut that opens the palette — so deleting the button would remove the only accessible append path on a non-empty canvas. It becomes the first control in the bottom-right cluster (`+`, accessible name `Add step`), which still retires the free-floating top-right box. Alternative considered: add a `⌘K` palette shortcut and delete the button — rejected as scope creep into keyboard bindings.

**Zoom cluster drops from five buttons to three.** `−`, a live percentage readout button, `+`. The readout replaces the separate `1:1` button: its label is `Math.round(view.z * 100) + "%"`, updated wherever `applyView` runs, and activating it calls the existing `zoomAt(1 / view.z)`. Fit and expand move to the second cluster, keeping their exact `name` strings (`Fit canvas`, `Expand canvas`, `Exit expanded canvas`) because the presentation test asserts them.

**Shortcuts help is a toggle plus the existing `tip` element.** The `tip` span keeps its text and gains `hidden`; a `?` button in the view cluster toggles it and mirrors state into `aria-expanded`. The canvas root's existing Escape handler gains one branch, ordered after the palette and before the expansion branch, so Escape closes help first and only then leaves the expanded canvas.

**The canvas takes the reclaimed height.** `.canvas` moves from `flex: none; height: 62vh` to `flex: 1 1 auto` with its `min-height` kept, so the height the retired bands freed goes to the graph rather than to dead space under it. Because the canvas height now depends on its siblings, `setMode("visual")` hides the code editor *before* `canvas.load()` runs, so the `fit()` inside `load()` measures the height the canvas will keep. The narrow-viewport block pins `flex: none` back on, where a fixed canvas height is what keeps the stacked layout scrollable.

**One control bar, one indicator: text.** The unsaved state stays the existing `unsaved changes` element (yellow text — colour *and* text, which is what the requirement asks for); no separate state dot is introduced, since a dot beside the same words would restate it. Validity has no steady-state indicator at all: silence means valid, and a problem prints its message in the status line.

**The bar's split degrades by breaking, not by shrinking.** `.bar-spacer` is `flex: 1 1 auto` on wide viewports and `flex: 1 0 100%` under the narrow breakpoint, which turns the spacer into a line break: identity on the first line, controls on the second. History folds into the overflow menu there (`.bar .hist` hidden, `.hist-item` shown), and the two menu items share the bar buttons' disabled state through their `pair` reference so a folded Undo is never offered when there is nothing to undo.

**Narrow viewports get the same layout, stacked.** Since the change is about giving the editor the screen, it carries down to phone widths: `main` becomes a single column with the list as a horizontally scrollable strip, the canvas keeps a fixed usable height, and edge-anchored canvas controls use `max(<gap>, env(safe-area-inset-*))`. A header control hides and shows the list — it reports its state through `aria-expanded`/`aria-pressed`, is absent on the config and runs tabs and in the share/import views, and opening a workflow on a narrow viewport collapses the list so the editor is what fills the screen.

**Menus name themselves.** `mkMenu(label, items, name)` takes an optional accessible name because `⋯` is not one; the overflow trigger is `More actions`. Closing returns focus to the trigger only when the close was deliberate (Escape, item activation) — an outside pointerdown closes without stealing focus from whatever the user just clicked.

**`foot` is deleted outright.** `setFoot` shrinks to the `canvas.setTrigger(...)` call it already makes, and keeps being called from `nameIn.oninput`. The command stays visible on the trigger node in canvas mode; in yaml mode the name is in the bar and `steps:` is on screen, so nothing needs to restate the invocation.

## Risks / Trade-offs

- **A crowded bar at intermediate widths (name + scope + chip + mode + history + unsaved + save + `⋯`)** → the trailing group folds history into the overflow menu under a `max-width` breakpoint, and the bar keeps `flex-wrap: wrap` as the final fallback so nothing is ever clipped.
- **In yaml mode the run command is no longer shown anywhere** → accepted: the name field is in the bar and the command form is `hwf run <name>`; the canvas mode caption remains the single source.
- **Two 32px clusters over the canvas can cover nodes near the bottom corners** → `fit()` already insets by 120px on both axes, which clears both clusters at every zoom level; no change needed.
- **String-grep presentation tests are easy to break in ways that do not indicate a real regression** → the asserted names, `aria-label`s and `min-height` rules are preserved verbatim; test edits are limited to the retired footer, the retired banner, and additions for the new menu.
- **Removing controls users have muscle memory for (copy/download/delete)** → they stay one click away behind a control adjacent to their old position, and delete keeps its confirmation, so the destructive path is no easier to trigger by accident than before.

## Open Questions

- None. The shortcuts-help state is deliberately not persisted; if usage shows people re-open it every session, a `localStorage` key can be added later alongside the theme preference.
