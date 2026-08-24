## ADDED Requirements

### Requirement: In-popup editor stays on the popup tty
Palette `o` MUST open the selected valid workflow in `$EDITOR` or `$VISUAL` through `tea.ExecProcess` on the picker popup tty, wait for the editor to exit, validate with the loader, show status, and keep the picker open. When neither `EDITOR` nor `VISUAL` is set, the picker MUST fail with an error that names those variables and MUST NOT fall back to `vi`. The large percent popup is the editor surface. The picker MUST NOT hand the file to a second pane to work around popup size.

#### Scenario: Open uses ExecProcess
- **WHEN** repo workflow `deploy` is selected and the user presses `Ctrl+K` then `o` with `EDITOR` set
- **THEN** the picker runs that editor on the popup tty, validates on exit, shows status, and stays open

#### Scenario: Missing editor is a hard error
- **WHEN** the user fires palette `o` and neither `EDITOR` nor `VISUAL` is set
- **THEN** the picker shows an error that names `EDITOR` and `VISUAL` and does not launch `vi`
