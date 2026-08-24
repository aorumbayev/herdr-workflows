## 1. Manifest and theme

- [x] 1.1 Set picker `width` and `height` in `herdr-plugin.toml` to `"85%"` and `"80%"`. Sync the embed copy
- [x] 1.2 Extend `tui.Theme` with kind slots (agent 6, run 2, herdr 5, workflow 4, default 7), hover (not reverse), fail 1, and run status helpers. Cover with theme tests
- [x] 1.3 Add `tui.FormatTabBar` with active reverse and inactive muted ASCII labels. Cover with a unit test

## 2. Picker tabs and pop-out

- [x] 2.1 Cycle Tab through workflows, runs, and embedded console. Keep the no-switch guards. Show the tab bar on root browsers
- [x] 2.2 Embed `console.Model` for browse. Intercept Tab. Wire `p` on the console tab to `beginConsolePlacement`. Keep palette `c`
- [x] 2.3 Apply muted detail and footer, warn on `invalid` and `!`, workflow kind on titles, reverse cursor, distinct hover

## 3. Mouse and runs colors

- [x] 3.1 Set picker `View.MouseMode` to `MouseModeAllMotion`. Handle hover, wheel, and pointer-select with keyboard twins. Do not drop mouse in `FilterInput`
- [x] 3.2 Color runs-tab status text with the locked slots while keeping textual status

## 4. Parity, Charm, docs, verify

- [x] 4.1 Re-judge `internal/picker/parity.go` and `tui.CharmVerdicts` plus `docs/charm-components.md`
- [x] 4.2 Update `docs/surfaces.md` tab, size, pop-out, and color copy
- [x] 4.3 Run `go tool verify` (move gitignored TypeScript/JS aside for the repo scan, restore after)
