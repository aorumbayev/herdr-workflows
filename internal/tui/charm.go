package tui

// CharmVerdict records one hand-written TUI mechanism and one Charm candidate.
type CharmVerdict struct {
	Mechanism         string
	CandidateModule   string
	CandidateVersion  string
	Decision          string
	MissingCapability string
	Test              string
}

// CharmVerdicts is Decision 16: keep custom code unless a Charm component meets
// required behavior with less product code and unchanged UX.
func CharmVerdicts() []CharmVerdict {
	const (
		bubbles    = "charm.land/bubbles/v2"
		bubblesV   = "v2.1.1"
		huh        = "charm.land/huh/v2"
		huhV       = "v2.0.3"
		lipgloss   = "charm.land/lipgloss/v2"
		lipglossV  = "v2.0.6"
		bubbletea  = "charm.land/bubbletea/v2"
		bubbleteaV = "v2.0.9"
		xansi      = "github.com/charmbracelet/x/ansi"
		xansiV     = "v0.11.8"
	)
	return []CharmVerdict{
		{
			Mechanism:         "height-fitted-list-viewport",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "list.Model SetHeight does fit rows to the host, but it always owns PerPage plus paginator chrome and cannot drop the thumb the picker chrome forbids. FitViewport is one expression over the existing cursor-offset window.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "filter-text-accumulation",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "textinput.Model and list FilterInput insert printable text without product key routing for Ctrl+P, Tab, and Ctrl+G versus bare letters in the same filter field.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "filter-input-stdin-leak-drop",
			CandidateModule:   bubbletea,
			CandidateVersion:  bubbleteaV,
			Decision:          "keep-custom",
			MissingCapability: "tea.WithFilter has no built-in herdr prefix-key C0 leak allowlist that keeps Tab, LF, CR, ESC, Ctrl+K, Ctrl+P, and Ctrl+G while dropping other controls.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "choice-list-custom-row",
			CandidateModule:   huh,
			CandidateVersion:  huhV,
			Decision:          "keep-custom",
			MissingCapability: "huh.Select has no tagged custom... sentinel row that opens a free-text field while keeping the same six-row ASCII choice chrome.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "text-prompt",
			CandidateModule:   huh,
			CandidateVersion:  huhV,
			Decision:          "keep-custom",
			MissingCapability: "huh.Input is a standalone form field. It does not share picker filter/backtrack state or ASCII SubmitHint chrome with collected answers.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "footer-position-counter",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "list status bar and help.Model do not render hint-left index/total-right footers that clip the hint before the counter under a fixed content width.",
			Test:              "TestFormatListFooter",
		},
		{
			Mechanism:         "two-line-detail-wrap",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss has no two-line word-wrap helper that indents by RowTextIndent and truncates only the second line with ASCII ellipsis.",
			Test:              "TestFormatDetailLines",
		},
		{
			Mechanism:         "inset-muted-rule",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss has no inset horizontal rule that matches RowTextIndent and fills the remaining cells with ASCII dashes.",
			Test:              "TestFormatRuleInsetMuted",
		},
		{
			Mechanism:         "chrome-horizontal-padding",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss.Padding does not pair with StripContentPadding or Truncate ASCII ellipsis for one-cell popup inset on every line.",
			Test:              "TestPadContentAddsHorizontalPadding",
		},
		{
			Mechanism:         "detail-block-height",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss Style.Height reserves blank rows but does not wrap detail text onto two indented lines with ASCII ellipsis on line two.",
			Test:              "TestFormatDetailBlockReservesTwoRows",
		},
		{
			Mechanism:         "column-row-layout",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "list ItemDelegate has no built-in cursor-prefix, title truncate, warning, and right location columns that match FormatPickerRowName widths.",
			Test:              "TestPadColumnsKeepsASCIIIndicatorSingleColumn",
		},
		{
			Mechanism:         "ascii-chrome-strings",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "bubbles default styles and glyphs are not constrained to single-column ASCII chrome fragments required by ChromeStrings.",
			Test:              "TestChromeStringsAreSingleColumnASCII",
		},
		{
			Mechanism:         "terminal-column-truncate",
			CandidateModule:   xansi,
			CandidateVersion:  xansiV,
			Decision:          "keep-custom",
			MissingCapability: "x/ansi supplies StringWidth, Cut, and Truncate. Product Truncate still owns ASCII Ellipsis and PadColumns cell padding used by picker rows.",
			Test:              "TestTruncateEllipsisAtMax",
		},
		{
			Mechanism:         "theme-warn-muted",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss styles colors but has no ready Theme with indexed ANSI warn (3), muted (8), and reverse selection without OSC 4 queries.",
			Test:              "TestDefaultThemeUsesIndexedWarnMutedAndReverse",
		},
		{
			Mechanism:         "filter-row-update-indicator",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "list FilterInput has no width-gated ASCII update hint that hides when the filter field would drop below four cells.",
			Test:              "TestPadColumnsKeepsASCIIIndicatorSingleColumn",
		},
		{
			Mechanism:         "palette-body",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "bubbles has no ctrl+p letter-fire palette that keeps list filter state and hides edit/share/delete without a valid selection.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "delete-confirm-yn",
			CandidateModule:   huh,
			CandidateVersion:  huhV,
			Decision:          "keep-custom",
			MissingCapability: "huh.Confirm uses Enter or dedicated bindings. It does not match bare y/n/esc ASCII DeleteConfirmHint without replacing picker delete mode.",
			Test:              "TestChromeStringsAreSingleColumnASCII",
		},
		{
			Mechanism:         "collected-answers-truncation",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "bubbles has no chosen: name=value join truncated with ASCII ellipsis under content width for sequential input answers.",
			Test:              "TestTruncateEllipsisAtMax",
		},
		{
			Mechanism:         "viewport-height-pad",
			CandidateModule:   bubbletea,
			CandidateVersion:  bubbleteaV,
			Decision:          "keep-custom",
			MissingCapability: "bubbletea does not clear unused TTY rows after a shorter frame, and its inline renderer erases and redraws whenever the frame line count changes. PadHeight holds one height so ghost rows do not linger and the frame does not blink.",
			Test:              "TestPadHeight",
		},
		{
			Mechanism:         "runs-detail-scroll",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "viewport.Model ships KeyMap bindings and enables MouseWheel by default. Product detail scroll and the console diagram keep a fixed ASCII window without importing bubbles or accepting that default input surface.",
			Test:              "TestScrollDetailLines",
		},
		{
			Mechanism:         "theme-kind-palette",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss has no ready Theme with indexed kind colors agent 6, run 2, herdr 5, workflow 4, default 7, fail 1, faint secondary text instead of a palette slot, underline hover distinct from reverse, and run status slots.",
			Test:              "TestDefaultThemeKindPaletteAndHover",
		},
		{
			Mechanism:         "picker-tab-bar",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "bubbles tabs do not center a three-label ASCII bar with reverse active and muted inactive states under picker chrome width rules, and give no column-to-tab hit test for the centered row.",
			Test:              "TestFormatTabBarActiveReverseInactiveMuted",
		},
		{
			Mechanism:         "picker-mouse-hover",
			CandidateModule:   bubbletea,
			CandidateVersion:  bubbleteaV,
			Decision:          "keep-custom",
			MissingCapability: "bubbletea reports mouse cells but does not map hover to a non-reverse row style while reverse remains the keyboard cursor.",
			Test:              "TestPickerHoverStyleIsNotReverse",
		},
		{
			Mechanism:         "console-hit-zones",
			CandidateModule:   "charm.land/bubbletea/v2",
			CandidateVersion:  "v2.0.9",
			Decision:          "keep-custom",
			MissingCapability: "bubbletea reports mouse cells but has no hit-zone registry mapping rail cards to their step anchors.",
			Test:              "TestModelDiagramClickFocusesCard",
		},
		{
			Mechanism:         "console-mouse-reporting",
			CandidateModule:   "charm.land/bubbletea/v2",
			CandidateVersion:  "v2.0.9",
			Decision:          "keep-custom",
			MissingCapability: "bubbletea mouse reporting is off unless the view sets MouseMode. Both console hosts must enable all-motion reporting or clicks never arrive.",
			Test:              "TestModelConsoleViewEnablesMouseReporting",
		},
		{
			Mechanism:         "card-rail",
			CandidateModule:   lipgloss,
			CandidateVersion:  lipglossV,
			Decision:          "keep-custom",
			MissingCapability: "lipgloss has no kind-colored double-border card rail with ASCII connectors and a paired detail pane.",
			Test:              "TestFormatDiagramHandoff",
		},
		{
			Mechanism:         "edit-placement",
			CandidateModule:   huh,
			CandidateVersion:  huhV,
			Decision:          "keep-custom",
			MissingCapability: "huh.Select does not mix an in-popup tea.ExecProcess path with plugin.pane.open placements that quit without reopening.",
			Test:              "TestEditPlacementTabQuitsWithoutReopen",
		},
		{
			Mechanism:         "failed-run-sendback",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "bubbles has no send-back that reuses the annotation bundle plus a failure block that excludes the captured output tail.",
			Test:              "TestRunsSendbackOmitsOutputTail",
		},
	}
}
