package tui

import (
	"strings"
	"testing"
	"unicode"
)

func TestCharmVerdicts(t *testing.T) {
	required := []string{
		"fixed-six-row-viewport",
		"filter-text-accumulation",
		"filter-input-stdin-leak-drop",
		"choice-list-custom-row",
		"text-prompt",
		"footer-position-counter",
		"two-line-detail-wrap",
		"inset-muted-rule",
		"column-row-layout",
		"ascii-chrome-strings",
		"terminal-column-truncate",
		"theme-warn-muted",
		"filter-row-update-indicator",
		"palette-body",
		"delete-confirm-yn",
		"collected-answers-truncation",
	}
	got := map[string]CharmVerdict{}
	for _, v := range CharmVerdicts() {
		if v.Mechanism == "" {
			t.Fatal("empty Mechanism")
		}
		if _, dup := got[v.Mechanism]; dup {
			t.Fatalf("duplicate Mechanism %q", v.Mechanism)
		}
		got[v.Mechanism] = v
	}
	for _, name := range required {
		v, ok := got[name]
		if !ok {
			t.Fatalf("missing Mechanism %q", name)
		}
		if v.CandidateModule == "" || v.CandidateVersion == "" {
			t.Fatalf("%s: empty CandidateModule or CandidateVersion", name)
		}
		switch v.Decision {
		case "use", "keep-custom":
		default:
			t.Fatalf("%s: Decision %q want use|keep-custom", name, v.Decision)
		}
		if v.Decision == "keep-custom" && strings.TrimSpace(v.MissingCapability) == "" {
			t.Fatalf("%s: keep-custom requires MissingCapability", name)
		}
		if strings.TrimSpace(v.Test) == "" {
			t.Fatalf("%s: empty Test", name)
		}
	}
	if len(got) != len(required) {
		t.Fatalf("verdict count %d want %d", len(got), len(required))
	}
}

func TestChromeStringsAreSingleColumnASCII(t *testing.T) {
	for _, chrome := range ChromeStrings {
		for _, r := range chrome {
			if r > unicode.MaxASCII {
				t.Fatalf("%q contains non-ASCII %U", chrome, r)
			}
			if unicode.IsControl(r) {
				t.Fatalf("%q contains control %U", chrome, r)
			}
		}
		if Columns(chrome) != len([]rune(chrome)) {
			t.Fatalf("%q columns %d != rune count %d", chrome, Columns(chrome), len([]rune(chrome)))
		}
	}
}

func TestFormatRuleInsetMuted(t *testing.T) {
	rule := FormatRule(60)
	if !strings.HasPrefix(rule, strings.Repeat(" ", RowTextIndent)) {
		t.Fatalf("rule missing indent: %q", rule)
	}
	field := strings.TrimLeft(rule, " ")
	if field != strings.Repeat("-", 60-RowTextIndent) {
		t.Fatalf("rule field = %q", field)
	}
	if FormatRule(10) != "   "+strings.Repeat("-", 7) {
		t.Fatalf("rule(10) = %q", FormatRule(10))
	}
}

func TestPadColumnsKeepsASCIIIndicatorSingleColumn(t *testing.T) {
	indicator := "[run hwf update]"
	if Columns(indicator) != len(indicator) {
		t.Fatalf("indicator cols %d want %d", Columns(indicator), len(indicator))
	}
	room := 40
	row := PadColumns(Truncate("filter workflows...", room), room) + " " + indicator
	want := room + 1 + Columns(indicator)
	if Columns(row) != want {
		t.Fatalf("row cols %d want %d (%q)", Columns(row), want, row)
	}
}
