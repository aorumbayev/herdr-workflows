## 1. Frame height

- [x] 1.1 Subtract the tab bar row in `picker.tabBodyHeight` and use it at every embedded browser size site
- [x] 1.2 Cover every picker screen at three heights in `TestPickerFrameFitsPopupHeight`

## 2. Viewports

- [x] 2.1 Add `tui.FitViewport` with a floor
- [x] 2.2 Derive the picker list viewport, its cursor clamp, and its pointer hit rows
- [x] 2.3 Derive the runs list and run detail viewports
- [x] 2.4 Reword the parity rows and re-judge the Charm viewport verdict

## 3. Diagram selection

- [x] 3.1 Keep a mark slot on every card and mute it when the step declares no id
- [x] 3.2 Say why `v` and `ctrl+click` cannot select that card, and clear the reason on focus move

## 4. Composer

- [x] 4.1 Share `anchorLabel` between the bundle and the composer
- [x] 4.2 Name the agent pane, the file, the anchor, and the focus steps
- [x] 4.3 Wrap the draft per line and keep the caret in view

## 5. Palette

- [x] 5.1 Draw palette rows through `tui.FormatRow` and mute the actions without a selection
- [x] 5.2 Close the palette body with the rule and the muted footer

## 6. Console tab

- [x] 6.1 Add `console.OpenDiagram` and open the selected workflow from `openConsoleTab`
- [x] 6.2 Own `tab` and `esc` in the picker while the console is not composing
- [x] 6.3 Reword the `picker-popup-ux` console browse scenarios

## 7. Popup geometry

- [x] 7.1 Add `host.PluginPaneOpenPopup` with cell or percent sizes
- [x] 7.2 Carry tab, filter, cursor, and offset in `HWF_PICKER_STATE`
- [x] 7.3 Respawn only when the size changes, and never from the restored process
- [x] 7.4 Reopen from a detached child that retries while the outgoing popup closes
- [x] 7.5 Set the manifest and its embed copy to the compact size

## 8. Frame blink

- [x] 8.1 Reserve the list status row so the frame keeps one line count
- [x] 8.2 Record the renderer erase in the `viewport-height-pad` verdict

## 9. Card-only rail

- [x] 9.1 Step the rail cursor card to card and drop gap hit zones and slots
- [x] 9.2 Ask before or after on `a`, keyboard-first, and carry that side in the anchor
- [x] 9.3 Delete `gapYAML`, `reresolveGap`, and the append connector
