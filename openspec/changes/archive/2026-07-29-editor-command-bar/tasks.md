## 1. Shared menu helper

- [x] 1.1 Add one `mkMenu(label, items)` helper near `mkBtn` in `src/web/page.html`: a trigger button (`aria-haspopup="menu"`, `aria-expanded`, accessible name from `label`) plus a `role="menu"` popover of `role="menuitem"` buttons.
- [x] 1.2 Wire the helper's behaviour: open moves focus to the first item, Escape and outside click close it and return focus to the trigger, activating an item closes it and runs the item's callback.
- [x] 1.3 Add `.menu` / `.menu-pop` CSS using existing tokens only (`--pop-bg`, `--pop-sel`, `--line`, `--ink-soft`), with `:focus-visible`, hover and active states and a 32px minimum item height. No colour literals.

## 2. Single command bar

- [x] 2.1 Replace `addbar` (the `append` caption and per-verb buttons) with one `+ step` menu built from `mkMenu`, keeping `addStep(verb)` unchanged as each item's callback.
- [x] 2.2 Move undo, redo, the unsaved text and save out of `bar2` into `bar1`, separated from the identity group by a spacer that pushes them right; keep `save`'s `hide` toggle, its `primary` class and its `aria-label`.
- [x] 2.3 Replace copy, download, delete (and the both-scopes delete select) with one `⋯` overflow menu from `mkMenu`; the both-scopes case becomes local/global/both menu items, each keeping the existing `confirm` before `dropScopes`.
- [x] 2.4 Delete `bar2`, and repoint `pane.append(...)` at the single bar.
- [x] 2.5 Turn `flagBox` into an inline chip inside the bar beside the name: keep `paintFlags`'s signature and `hide` behaviour, replace the `.flags` rule with a `.chip` rule.
- [x] 2.6 Stop rendering `valid`: pass the empty string on success in `showProblem`, add `.status:empty { display: none }`, and keep the failure text, `bad` class and jump-to-line behaviour exactly as they are.
- [x] 2.7 Add the narrow-viewport rule that folds the history cluster into the overflow menu below the bar's wrap width, so no control is ever clipped.

## 3. Canvas control clusters

- [x] 3.1 Reduce `zoombar` to `−`, a percentage readout button, `+`; drop the separate `1:1` entry and move fit and expand out.
- [x] 3.2 Make the readout live: label it `Math.round(view.z * 100) + "%"` wherever `applyView` runs, give it an accessible name stating it resets the zoom, and wire its click to `zoomAt(1 / view.z)`.
- [x] 3.3 Add the bottom-right view cluster holding add step, fit, expand and a `?` shortcuts toggle; keep the `Fit canvas`, `Expand canvas` and `Exit expanded canvas` names verbatim.
- [x] 3.4 Retire the floating `addnode` button: the add-step control is the first item of the view cluster, named `Add step`, still calling `openPalette(null)`. Remove the `.addnode` rule.
- [x] 3.5 Hide the `tip` text by default and toggle it from the `?` control, mirroring state into `aria-expanded`; add an Escape branch in the canvas root handler that closes help before the expansion branch.
- [x] 3.6 Give both clusters shared CSS with a 32px minimum in both dimensions per control, `:focus-visible`, hover and active states, and no colour literals.

## 4. Retire the footer

- [x] 4.1 Delete the `foot` element and its `.hint` usage in the editor pane; reduce `setFoot` to the `canvas.setTrigger(...)` call and keep it wired to `nameIn.oninput`.
- [x] 4.2 Confirm the trigger caption still updates on rename in canvas mode and that no other element restates `hwf run <name>`.

## 5. Tests and gates

- [x] 5.1 Update `test/web-presentation.test.ts`: drop assertions for the retired footer and banner, keep the existing name/`aria-label`/`min-height` assertions, and add assertions for the single bar, the menu roles, the percentage readout and the collapsed hint.
- [x] 5.2 Add an assertion that the editor renders no `run in a terminal:` text and no always-visible `tip`.
- [x] 5.3 Run `bun test ./test` and `npm run verify` (lint, format, types, comments, unused-code, duplicate-code, hardcoded-colors) and fix what they report.

## 6. Narrow viewports, list disclosure, and reclaimed height

- [x] 6.1 Give the canvas `flex: 1 1 auto` so the retired bands' height goes to the graph, and hide the code editor before `canvas.load()` so its `fit()` measures the final height.
- [x] 6.2 Add the narrow-viewport rules: single-column `main`, the workflow list as a horizontally scrollable strip, the bar spacer as a line break, a fixed usable canvas height, and safe-area insets on edge-anchored canvas controls.
- [x] 6.3 Add the header control that hides and shows the workflow list, with accessible name and expanded state, absent outside the workflows tab, and auto-collapsing when a workflow opens on a narrow viewport.
- [x] 6.4 Give `mkMenu` an optional accessible name (`More actions` for `⋯`), and return focus to the trigger only on a deliberate close.
- [x] 6.5 Mirror the bar's history disabled state onto the folded overflow items.

## 7. Visual verification

- [x] 7.1 Serve the workbench, open a workflow with steps in both themes, and check the bar, both canvas clusters, the chip, the overflow menu and the shortcuts toggle by screenshot.
- [x] 7.2 Check the expanded canvas keeps both clusters reachable, and check a narrow viewport keeps every control available.
