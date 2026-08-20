package history

import "testing"

func TestProgressLineRoundTripAndVisibleFormat(t *testing.T) {
	// Ports test/history/history-types.test.ts "progress line codec".
	cases := []ProgressLine{
		{Index: 1, Total: 3, Label: "build", Outcome: "start"},
		{Index: 2, Total: 3, Label: "build", Outcome: "ok"},
		{Index: 3, Total: 3, Label: "run: git diff HEAD", Outcome: "skip"},
		{Index: 3, Total: 12, Label: "review", Outcome: "fail"},
		{Index: 10, Total: 10, Label: "notification.show", Outcome: "launch"},
	}
	for _, progress := range cases {
		got := ParseProgressLine(FormatProgressLine(progress))
		if got == nil || *got != progress {
			t.Fatalf("round-trip %v got %+v", progress, got)
		}
	}
	if FormatProgressLine(ProgressLine{Index: 1, Total: 2, Label: "probe", Outcome: "start"}) != "[1/2] probe…" {
		t.Fatal("start format")
	}
	if FormatProgressLine(ProgressLine{Index: 1, Total: 2, Label: "probe", Outcome: "ok"}) != "[1/2] probe" {
		t.Fatal("ok format")
	}
	if FormatProgressLine(ProgressLine{Index: 2, Total: 2, Label: "probe", Outcome: "fail"}) != "[2/2] probe fail" {
		t.Fatal("fail format")
	}
	if ParseProgressLine("@hwf-history:claimed abc") != nil {
		t.Fatal("ack must not parse as progress")
	}
	if ParseProgressLine("plain diagnostic") != nil {
		t.Fatal("plain line")
	}
	if ParseProgressLine("[1/2]") != nil {
		t.Fatal("incomplete progress")
	}
}

func TestParseHistoryAck(t *testing.T) {
	claimed := ParseHistoryAck("@hwf-history:claimed 550e8400-e29b-41d4-a716-446655440000")
	if claimed == nil || claimed.State != "claimed" || claimed.ID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("%+v", claimed)
	}
	if ParseHistoryAck("plain") != nil {
		t.Fatal("plain")
	}
}
