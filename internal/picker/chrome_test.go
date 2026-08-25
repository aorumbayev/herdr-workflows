package picker

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/update"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestBuildInvalidOptionsStripsFilePrefix(t *testing.T) {
	// This test copies test/picker/picker.test.ts "invalid entries join the option list with stripped errors".
	_, invalid := FilterWorkflowEntries(catalogEntries(), "").Valid, FilterWorkflowEntries(catalogEntries(), "").Invalid
	options := BuildInvalidOptions(invalid, 60)
	want0 := FormatPickerRowName("Broken", "invalid", false, 60, false)
	if options[0].Name != want0 {
		t.Fatalf("invalid row = %q want %q", options[0].Name, want0)
	}
	if options[0].Description != "step 2, agent: unknown agent 'x'" {
		t.Fatalf("stripped error = %q", options[0].Description)
	}
	if strings.Contains(options[0].Description, "/r/broken.yaml") {
		t.Fatal("description still contains file path")
	}
	want1 := FormatPickerRowName("Chat Broken", "invalid", false, 60, false)
	if options[1].Name != want1 {
		t.Fatalf("second invalid row = %q want %q", options[1].Name, want1)
	}
	if options[1].Description != "cycle" {
		t.Fatalf("cycle description = %q", options[1].Description)
	}
}

func TestHumanizedTitleDefault(t *testing.T) {
	// This test copies test/picker/picker.test.ts "humanized title default and provenance badges".
	got := FilterWorkflowEntries(catalogEntries(), "")
	options := BuildPickerOptions(got.Valid, 60)
	if options[0].Name != "  "+" "+padEndJS("Chat handoff", 42)+"  "+"!"+"  "+padStartJS("repo", 7)+"   " {
		t.Fatalf("row0 = %q", options[0].Name)
	}
	if options[0].Description != "Pass transcript to a reviewer" {
		t.Fatalf("desc0 = %q", options[0].Description)
	}
	if options[1].Name != "  "+" "+padEndJS("Deploy", 42)+"  "+"!"+"  "+padStartJS("global", 7)+"   " {
		t.Fatalf("row1 = %q", options[1].Name)
	}
	if options[1].Description != "deploy" {
		t.Fatalf("desc1 = %q", options[1].Description)
	}
}

func TestInputsAreNotAdvertisedInTheRow(t *testing.T) {
	withInputs := workflow.ListEntry{
		Name: "ask", Source: "global", File: "/g/ask.yaml", Title: "Ask",
		Inputs: []workflow.InputSpec{{Name: "target", Type: "text"}},
	}
	without := workflow.ListEntry{Name: "ask", Source: "global", File: "/g/ask.yaml", Title: "Ask"}
	if BuildPickerOptions([]workflow.ListEntry{withInputs}, 60)[0].Name !=
		BuildPickerOptions([]workflow.ListEntry{without}, 60)[0].Name {
		t.Fatal("inputs changed the row")
	}
}

func TestFilterChoiceOptionsSubstring(t *testing.T) {
	options := []string{"main", "feat/workflow-inputs", "fix/token"}
	if got := FilterChoiceOptions(options, ""); !stringSlicesEqual(got, options) {
		t.Fatalf("empty filter = %v", got)
	}
	if got := FilterChoiceOptions(options, "feat"); !stringSlicesEqual(got, []string{"feat/workflow-inputs"}) {
		t.Fatalf("feat = %v", got)
	}
	if got := FilterChoiceOptions(options, "zzz"); len(got) != 0 {
		t.Fatalf("zzz = %v", got)
	}
}

func ptr[T any](v T) *T { return &v }

func TestFormatInputPrompt(t *testing.T) {
	if got := FormatInputPrompt(workflow.InputSpec{Name: "target", Type: "profile"}); got != "target | pick one" {
		t.Fatalf("profile = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "target", Type: "profile", Description: "Agent to hand off to"}); got != "target - Agent to hand off to | pick one" {
		t.Fatalf("described = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "focus", Type: "text"}); got != "focus | type free text" {
		t.Fatalf("text = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "branch", Type: "choice", Options: []string{"main"}, Description: "Which branch"}); got != "branch - Which branch | pick one of 1" {
		t.Fatalf("choice = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "ref", Type: "choice", Options: []string{"main", "dev", "next"}}); got != "ref | pick one of 3" {
		t.Fatalf("domain = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "branch", Type: "choice", Options: []string{"main"}, AllowCustom: true, MinLength: ptr(1)}); got != "branch | pick one of 1 | or type your own | min 1 char" {
		t.Fatalf("custom min = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "focus", Type: "text", Default: ptr("all")}); got != "focus | type free text | default all" {
		t.Fatalf("default = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "note", Type: "text", MinLength: ptr(4)}); got != "note | type free text | min 4 chars" {
		t.Fatalf("min4 = %q", got)
	}
	if got := FormatInputPrompt(workflow.InputSpec{Name: "ref", Type: "choice", DynamicOptions: &workflow.DynamicChoice{Run: []string{"git", "branch"}}}); got != "ref | pick one" {
		t.Fatalf("dynamic = %q", got)
	}
}

func TestFormatInputAnswers(t *testing.T) {
	queue := []workflow.InputSpec{
		{Name: "mode", Type: "choice", Options: []string{"create", "delete"}},
		{Name: "scope", Type: "choice", Options: []string{"one", "both"}},
	}
	if got := FormatInputAnswers(queue, map[string]string{"mode": "delete", "scope": "both"}, 60); got != "chosen: mode=delete | scope=both" {
		t.Fatalf("answers = %q", got)
	}
	if got := FormatInputAnswers(queue, map[string]string{}, 60); got != "" {
		t.Fatalf("empty = %q", got)
	}
	if got := FormatInputAnswers(queue, map[string]string{"mode": "delete", "scope": "both"}, 20); got != "chosen: mode=dele..." {
		t.Fatalf("truncated = %q", got)
	}
}

func TestChromeStringsAreSingleColumnASCII(t *testing.T) {
	for _, chrome := range tui.ChromeStrings {
		if tui.Columns(chrome) != utf8.RuneCountInString(chrome) {
			t.Fatalf("%q is not single-column", chrome)
		}
		if tui.Columns(chrome) != len(chrome) {
			t.Fatalf("%q multi-byte under ASCII claim", chrome)
		}
		for _, r := range chrome {
			if r < 0x20 || r > 0x7e {
				t.Fatalf("%q contains non-ASCII %q", chrome, r)
			}
		}
	}
	forbidden := "─│┌┐└┘═║→←↑↓▶◀▲▼►◄…"
	joined := strings.Join(tui.ChromeStrings, "")
	for _, r := range forbidden {
		if strings.ContainsRune(joined, r) {
			t.Fatalf("chrome contains box/arrow/heavy glyph %q", r)
		}
	}
}

func TestWideTitlesStayAligned(t *testing.T) {
	width := 60
	cjk := FormatPickerRowName(strings.Repeat("中", 59), "repo", true, width, false)
	emoji := FormatPickerRowName(strings.Repeat("😀", 40), "repo", true, width, false)
	ascii := FormatPickerRowName("Short", "repo", true, width, false)
	if tui.Columns(cjk) != tui.Columns(ascii) || tui.Columns(emoji) != tui.Columns(ascii) {
		t.Fatalf("widths cjk=%d emoji=%d ascii=%d", tui.Columns(cjk), tui.Columns(emoji), tui.Columns(ascii))
	}
	if cjk[len(cjk)-10:] != ascii[len(ascii)-10:] || emoji[len(emoji)-10:] != ascii[len(ascii)-10:] {
		t.Fatalf("location tails cjk=%q emoji=%q ascii=%q", cjk[len(cjk)-10:], emoji[len(emoji)-10:], ascii[len(ascii)-10:])
	}
	if tui.Columns(cjk) > width {
		t.Fatalf("cjk wider than row: %d", tui.Columns(cjk))
	}
	if !utf8.ValidString(cjk) || !utf8.ValidString(emoji) {
		t.Fatal("wide title rows must stay valid UTF-8")
	}

	narrowWidth := 28
	narrowCJK := FormatPickerRowName(strings.Repeat("中", 40), "repo", true, narrowWidth, false)
	narrowASCII := FormatPickerRowName("Short", "repo", true, narrowWidth, false)
	if tui.Columns(narrowCJK) != tui.Columns(narrowASCII) {
		t.Fatalf("narrow misaligned cjk=%d ascii=%d (%q vs %q)", tui.Columns(narrowCJK), tui.Columns(narrowASCII), narrowCJK, narrowASCII)
	}
	if tui.Columns(narrowCJK) > narrowWidth {
		t.Fatalf("narrow overflow %d > %d (%q)", tui.Columns(narrowCJK), narrowWidth, narrowCJK)
	}
	locTail := narrowCJK[len(narrowCJK)-7:]
	if locTail != narrowASCII[len(narrowASCII)-7:] {
		t.Fatalf("narrow location tails cjk=%q ascii=%q", locTail, narrowASCII[len(narrowASCII)-7:])
	}
}

func TestPaletteLetters(t *testing.T) {
	if !strings.Contains(tui.ListHint, "tab") || !strings.Contains(tui.ListHint, "ctrl+p") {
		t.Fatalf("list hint = %q", tui.ListHint)
	}
	if ResolvePaletteLetter("n", nil).ID != "new" || ResolvePaletteLetter("i", nil).ID != "import" {
		t.Fatal("n/i")
	}
	if ResolvePaletteLetter("e", nil).ID != "examples" {
		t.Fatal("e")
	}
	if ResolvePaletteLetter("o", nil) != nil || ResolvePaletteLetter("s", nil) != nil || ResolvePaletteLetter("d", nil) != nil {
		t.Fatal("selection-dependent without row")
	}
	empty := FormatPaletteBody(nil, 80)
	if strings.Contains(empty, "edit") || strings.Contains(empty, "share") || strings.Contains(empty, "delete") {
		t.Fatalf("empty palette leaked selection actions:\n%s", empty)
	}
	for _, label := range []string{"new", "import", "examples", "console"} {
		if !strings.Contains(empty, label) {
			t.Fatalf("empty palette missing %q:\n%s", label, empty)
		}
	}
	entry := workflow.ListEntry{Name: "deploy", Source: "repo", File: "/r/d.yaml"}
	if got := ResolvePaletteLetter("o", &entry); got == nil || got.ID != "open" || got.Entry == nil || got.Entry.Name != "deploy" {
		t.Fatalf("open = %+v", got)
	}
	if got := ResolvePaletteLetter("s", &entry); got == nil || got.Entry.Name != "deploy" {
		t.Fatalf("share = %+v", got)
	}
	if got := ResolvePaletteLetter("d", &entry); got == nil || got.ID != "delete" {
		t.Fatalf("delete = %+v", got)
	}
	full := FormatPaletteBody(&entry, 80)
	for _, label := range []string{"new", "import", "examples", "console", "edit", "share", "delete"} {
		if !strings.Contains(full, label) {
			t.Fatalf("selected palette missing %q:\n%s", label, full)
		}
	}
	if ResolvePaletteLetter("x", &entry) != nil {
		t.Fatal("x")
	}
}

func TestBeginConfirmedDeleteClaimsOnce(t *testing.T) {
	entry := catalogEntries()[1]
	state := DeleteState{PendingDelete: &entry}
	got := BeginConfirmedDelete(&state)
	if got == nil || got.Name != "deploy" || state.PendingDelete != nil || !state.DeleteInFlight {
		t.Fatalf("first claim %+v %+v", got, state)
	}
	if BeginConfirmedDelete(&state) != nil {
		t.Fatal("second claim")
	}
	again := DeleteState{PendingDelete: &entry, DeleteInFlight: true}
	if BeginConfirmedDelete(&again) != nil {
		t.Fatal("in-flight claim")
	}
}

func TestStdinLeakFilter(t *testing.T) {
	if ShouldDropStdinLeakSequence(string(rune(0x0b))) || ShouldDropStdinLeakSequence(string(rune(0x07))) {
		t.Fatal("ctrl+k/g must survive")
	}
	if ShouldDropStdinLeakSequence(string(rune(0x10))) {
		t.Fatal("ctrl+p must survive")
	}
	if !ShouldDropStdinLeakSequence(string(rune(0x05))) || !ShouldDropStdinLeakSequence(string(rune(0x0f))) {
		t.Fatal("ctrl+e/o must drop")
	}
	for _, keep := range []string{"\t", "\n", "\r", "\x1b", "e", "ab"} {
		if ShouldDropStdinLeakSequence(keep) {
			t.Fatalf("kept %q dropped", keep)
		}
	}
	if !ShouldDropStdinLeakSequence(string(rune(0x01))) || !ShouldDropStdinLeakSequence(string(rune(0x18))) {
		t.Fatal("ctrl+a/x must drop")
	}
}

func TestCustomChoiceHelpers(t *testing.T) {
	if !ShouldRestoreCustomChoiceText(true, "", []string{"main"}, true) {
		t.Fatal("empty custom")
	}
	if !ShouldRestoreCustomChoiceText(true, "feature/x", []string{"main"}, true) {
		t.Fatal("out of domain")
	}
	if ShouldRestoreCustomChoiceText(true, "main", []string{"main"}, true) {
		t.Fatal("in domain")
	}
	if ShouldRestoreCustomChoiceText(false, "", []string{"main"}, true) {
		t.Fatal("no answer")
	}
	if ShouldRestoreCustomChoiceText(true, "feature/x", []string{"main"}, false) {
		t.Fatal("custom disabled")
	}
}

func TestUpdateIndicator(t *testing.T) {
	if UpdateIndicator != "[run hwf update]" || !strings.Contains(UpdateIndicator, "run hwf update") {
		t.Fatalf("indicator = %q", UpdateIndicator)
	}
	if FormatFilterUpdateHint(10) != "" {
		t.Fatal("narrow")
	}
	if FormatFilterUpdateHint(len(UpdateIndicator)+6) != "" {
		t.Fatal("still cramped")
	}
	if FormatFilterUpdateHint(len(UpdateIndicator)+7) != UpdateIndicator {
		t.Fatal("just fits")
	}
	if FormatFilterUpdateHint(80) != UpdateIndicator {
		t.Fatal("wide")
	}
	if FormatListFilterRow("", 80, "") != tui.FilterWorkflows {
		t.Fatalf("placeholder = %q", FormatListFilterRow("", 80, ""))
	}
	if FormatListFilterRow("dep", 80, "") != "dep" {
		t.Fatalf("typed = %q", FormatListFilterRow("dep", 80, ""))
	}
	got := FormatListFilterRow("", 80, UpdateIndicator)
	if !strings.Contains(got, tui.FilterWorkflows) || !strings.Contains(got, UpdateIndicator) {
		t.Fatalf("hint row = %q", got)
	}
	if !UpdateAvailable("0.1.0", "0.2.0") || UpdateAvailable("0.2.0", "0.2.0") || UpdateAvailable("0.3.0", "0.2.0") || UpdateAvailable("0.1.0", "not-a-version") {
		t.Fatal("semver gate")
	}
}

func TestStartUpdateCheckNeverBlocksAndIgnoresFailures(t *testing.T) {
	newer := make(chan string, 1)
	started := make(chan struct{})
	block := make(chan *update.LatestRelease)
	StartUpdateCheck(UpdateCheck{
		Check: func() (*update.LatestRelease, error) {
			close(started)
			return <-block, nil
		},
		EmbeddedVersion: "0.1.0",
		OnNewer:         func(v string) { newer <- v },
	})
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("check did not start")
	}
	select {
	case <-newer:
		t.Fatal("fired before check returned")
	default:
	}
	block <- &update.LatestRelease{Version: "0.2.0"}
	select {
	case v := <-newer:
		if v != "0.2.0" {
			t.Fatalf("newer = %q", v)
		}
	case <-time.After(time.Second):
		t.Fatal("newer not delivered")
	}

	fail := make(chan struct{}, 1)
	StartUpdateCheck(UpdateCheck{
		Check:           func() (*update.LatestRelease, error) { return nil, errNet },
		EmbeddedVersion: "0.1.0",
		OnNewer:         func(string) { fail <- struct{}{} },
	})
	StartUpdateCheck(UpdateCheck{
		Check:           func() (*update.LatestRelease, error) { return &update.LatestRelease{Version: "0.1.0"}, nil },
		EmbeddedVersion: "0.1.0",
		OnNewer:         func(string) { fail <- struct{}{} },
	})
	StartUpdateCheck(UpdateCheck{
		Check:           func() (*update.LatestRelease, error) { return &update.LatestRelease{Version: "0.0.9"}, nil },
		EmbeddedVersion: "0.1.0",
		OnNewer:         func(string) { fail <- struct{}{} },
	})
	time.Sleep(50 * time.Millisecond)
	select {
	case <-fail:
		t.Fatal("onNewer fired for equal/older/error")
	default:
	}
}

type netErr struct{}

func (netErr) Error() string { return "network" }

var errNet netErr
