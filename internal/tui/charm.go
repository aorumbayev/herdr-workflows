package tui

// CharmVerdict records one hand-written TUI mechanism against a Charm candidate.
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
		bubbles   = "charm.land/bubbles/v2"
		bubblesV  = "v2.1.1"
		huh       = "charm.land/huh/v2"
		huhV      = "v2.0.3"
		lipgloss  = "charm.land/lipgloss/v2"
		lipglossV = "v2.0.6"
		xansi     = "github.com/charmbracelet/x/ansi"
		xansiV    = "v0.11.8"
	)
	return []CharmVerdict{
		{
			Mechanism:         "fixed-six-row-viewport",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "list.Model pagination always owns PerPage and optional paginator chrome. It cannot lock a fixed six-row viewport with cursor-offset scrolling and no scroll thumb.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "filter-text-accumulation",
			CandidateModule:   bubbles,
			CandidateVersion:  bubblesV,
			Decision:          "keep-custom",
			MissingCapability: "textinput.Model and list FilterInput insert printable text without product key routing for Ctrl+K, Tab, and Ctrl+G versus bare letters in the same filter field.",
			Test:              "TestCharmVerdicts",
		},
		{
			Mechanism:         "filter-input-stdin-leak-drop",
			CandidateModule:   "charm.land/bubbletea/v2",
			CandidateVersion:  "v2.0.9",
			Decision:          "keep-custom",
			MissingCapability: "tea.WithFilter has no built-in herdr prefix-key C0 leak allowlist that keeps Tab, LF, CR, ESC, Ctrl+K, and Ctrl+G while dropping other controls.",
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
			MissingCapability: "bubbles has no ctrl+k letter-fire palette that keeps list filter state and selection-dependent open/share/delete lines. Mechanism stays picker-owned.",
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
	}
}
