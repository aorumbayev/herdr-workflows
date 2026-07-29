## Context

`runPickerPopup` exits with `die("no workflows found")` before mounting when `hasVisibleEntries` is false, so hotkey launch flashes an empty popup. List-mode authorship uses global Ctrl chords (`E`/`Y`/`O`) that fight terminal C0 collisions (notably Ctrl+I ≡ Tab) and overload the footer. Workbench already has `+ new`, import review, delete, and export→`hwf workflow import "…"`. Share-from-picker today opens the workbench share route; the desired path copies that command in-process.

## Goals / Non-Goals

**Goals:**

- Mount picker on empty catalog with a friendly empty state; hide filter until workflows exist; distinct filter-miss copy.
- Single list-mode entry `Ctrl+K` → actions palette; letter accelerators fire immediately; scoped so `i` is safe.
- Palette: new/import/examples/open/share-copy/delete-with-confirm as agreed.
- Share: clipboard + `notification.show` ("Workflow {name} has been copied to clipboard"); picker stays open.
- Import: workbench `#import` (review UX). New: workbench `#new`.
- Raw YAML import on the workbench only (name field). CLI import stays bundle/command only.
- Default workbench workflows view exposes Import (always) and Share (from a saved workflow editor) so palette deep links are not the only entry.

**Non-Goals:**

- CLI file-path, stdin, or `--name` raw YAML import (web owns freeform).
- Multi-document YAML paste, or inventing names from `title:` without a prompt.
- Global Ctrl chords for each action; action rows always visible in the list.
- Changing run/input/run-failure picker flows.
- Changing picker `s` away from clipboard copy (workbench `#share=` remains the rich share UI).

## Decisions

1. **Palette over global chords** — Discoverable list of verbs; letters only while palette (or delete-confirm) is focused, so they never hit the filter and avoid C0 collisions. Alternatives: action rows (rejected for viewport cost on full catalogs); direct `^i` (impossible in PTY).

2. **Letter map** — `n` new, `i` import, `e` examples, `o` open/edit, `s` share/copy, `d` delete → `y`/`n` confirm. Open uses `o` so `e` can mean examples.

3. **Share = export + clipboard + notification** — Reuse `exportWorkflowBundle` / `formatImportCommand`. Clipboard via platform tools (`pbcopy` / `wl-copy` / `xclip`) with clear failure notification if none. Keep picker open; close palette back to list.

4. **Delete in picker** — Unlink the selected entry's file path (same scope semantics as workbench delete for that provenance), confirm with `y`/`n`, refresh `listWorkflows`, return to list/empty state. No workbench round-trip.

5. **Empty catalog** — Remove CLI early `die`. Empty body copy as product text; footer `ctrl+k · esc`. No filter row.

6. **`#new` route** — Extend `parseWebRoute` / `hwf web` with `new` (hash `#new`); page calls existing `newWorkflow()` seed.

7. **Raw YAML only on workbench** — After bundle decode fails and text looks like workflow YAML, `parseRaw` + require name in the import UI. CLI never takes this path; it keeps rejecting non-bundle input.

8. **Workbench chrome for import/share** — Sidebar: Import control next to `+ new` calls `openImport()`. Editor toolbar for a saved named workflow: Share control calls `openShare(scope, name)`. Same route UIs as `#import` / `#share=`.

9. **Stdin leak allowlist** — Replace Ctrl+E/O/Y C0 allowlist with Ctrl+K (`0x0b`); letters handled only in palette key handler.

## Risks / Trade-offs

- [Clipboard unavailable] → Mitigation: herdr notification with failure text; no silent success.
- [Delete races workbench open on same file] → Mitigation: same as workbench delete today; refresh list after success.
- [Muscle-memory break for Ctrl+E/Y/O] → Mitigation: **BREAKING** in proposal; footer teaches `ctrl+k` only.
- [Raw YAML mis-detected as bad base64] → Mitigation: ordered detect on workbench only; YAML path only when decode fails and body looks like workflow YAML; errors name expected shapes.
- [Ctrl+K conflict with other apps] → Mitigation: only inside picker popup PTY; herdr prefix keys already drained.

## Migration Plan

Ship as one plugin release. No data migration. Docs/footer/tests update in same change. Rollback = revert release (old chords return).

## Open Questions

_(none — resolved in explore)_
