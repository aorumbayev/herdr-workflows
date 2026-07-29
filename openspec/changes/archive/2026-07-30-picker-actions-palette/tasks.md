## 1. Routes and payload intake

- [x] 1.1 Extend `parseWebRoute` / CLI `hwf web` to accept `new` (`#new`)
- [x] 1.2 Handle `#new` in `page.html` via existing `newWorkflow()` seed
- [x] 1.3 Add raw-YAML → single-entry bundle helper (name required) for workbench import only
- [x] 1.4 Workbench import UI: accept raw YAML, prompt/require name before confirm
- [x] 1.5 CLI `workflow import` stays bundle/command only (no path/stdin/`--name`)

## 2. Picker empty / filter chrome

- [x] 2.1 Remove empty-catalog `die` in `runPickerPopup`; mount with empty entries
- [x] 2.2 Empty-state message + hide filter; footer `ctrl+k · esc`
- [x] 2.3 Filter-miss message distinct from empty catalog; filter stays visible when catalog nonempty
- [x] 2.4 Update list footer to `enter run · ctrl+k · esc` (no Ctrl+E/Y/O)

## 3. Actions palette

- [x] 3.1 Replace Ctrl+E/Y/O handlers and stdin C0 allowlist with Ctrl+K palette mode
- [x] 3.2 Letter accelerators: `n` new, `i` import, `e` examples URL, `o` open/edit (selection), dismiss on workbench handoff
- [x] 3.3 `s` share: export bundle, clipboard copy, `notification.show` “Workflow {name} has been copied to clipboard”, keep picker open
- [x] 3.4 `d` delete: confirm `y`/`n`, unlink selected file, refresh list, keep picker open
- [x] 3.5 Disable/omit selection-bound actions when no valid selection

## 4. Workbench default-view affordances

- [x] 4.1 Workflows list: Import control beside New → `#import`
- [x] 4.2 Saved-workflow editor: Share control → `#share=<scope>:<name>`

## 5. Tests and docs

- [x] 5.1 Unit tests: routes `new`, workbench raw YAML import, picker palette letters, empty/filter-miss
- [x] 5.2 Update product docs (Ctrl+K palette; web freeform vs CLI bundle-only; list Import / editor Share)
- [x] 5.3 `bun test ./test` and `CI=1 npm run verify` in the worktree
