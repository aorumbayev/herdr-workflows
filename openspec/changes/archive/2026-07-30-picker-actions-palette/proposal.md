## Why

An empty workflow catalog makes the picker popup flash and die with `no workflows found`, leaving no path to create, import, or discover examples. Authorship actions today are scattered across fragile global Ctrl chords (`Ctrl+E`/`Y`/`O`) that collide with terminal C0 realities and teach a custom keymap instead of a discoverable command surface.

## What Changes

- Mount the picker when the catalog is empty; show a friendly empty state (no filter). Filter input appears only when visible workflows exist; a non-matching filter shows a distinct "no workflows matching …" message.
- **BREAKING:** Replace list-mode `Ctrl+E` / `Ctrl+Y` / `Ctrl+O` with a `Ctrl+K` actions palette. While the palette is open, a single letter fires the action (no Enter required). List footer becomes `enter run · ctrl+k · esc` (empty: `ctrl+k · esc`).
- Palette actions: `n` new (workbench `#new`), `i` import (workbench `#import`), `e` examples (open docs URL in browser), `o` open/edit selected (workbench editor), `s` share selected by copying the connected-bundle `hwf workflow import "…"` command and showing a herdr `notification.show` that the workflow was copied (picker stays open), `d` delete selected with a `y`/`n` confirmation (no workbench).
- Add workbench deep-link `#new` for a blank editor.
- **Web owns freeform import:** workbench `#import` accepts bundle/command **or** pasted raw workflow YAML (explicit name in UI). **CLI stays bundle-only:** `hwf workflow import` accepts only the encoded bundle or the canonical import command (no file path, stdin YAML, or `--name`).
- Workbench default workflows view MUST expose Import and Share the same ways deep links do: an Import control always available beside New; Share available for a saved workflow from the editor (opens the existing `#share=` UI). Palette redirects must not be the only door.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `picker-presentation`: empty-catalog UI, filter visibility rules, filter-miss copy, simplified list footer.
- `picker-workbench-actions`: Ctrl+K palette + letter accelerators; retire Ctrl+E/Y/O; share-as-copy + notification; delete-with-confirm; examples browser open; new/import/edit workbench handoffs; endpoint reuse unchanged for workbench launches.
- `workflow-sharing`: workbench import accepts raw YAML (with explicit name) in addition to bundle/command; CLI import remains bundle/command only.
- `hwf-cli`: empty picker no longer dies; `hwf web` accepts `new` route; `workflow import` operand stays bundle/command only.
- `web-workbench-editing`: `#new` opens the blank unsaved editor (same seed as the workbench "+ new" control).
- `web-workbench-presentation`: default workflows list exposes Import; saved-workflow editor exposes Share into the existing share route UI.

## Impact

- `src/cli.ts` — remove empty-catalog `die` only (import argv unchanged aside from docs).
- `src/tui/picker.ts` (+ tests) — empty/filter-miss chrome; Ctrl+K palette; delete/share/copy/notify; retire old shortcuts.
- `src/tui/picker-actions.ts` — palette helpers (clipboard, examples, delete, share-copy).
- `src/web/route.ts`, `src/web/page.html`, `src/web/server.ts` — `#new`; raw YAML import + name field; list Import + editor Share controls.
- `src/workflow/payload.ts` / `import.ts` — detect/parse raw YAML into a single-entry bundle with supplied name (workbench path).
- Specs and docs that mention Ctrl+E/Y/O or empty-picker failure.
