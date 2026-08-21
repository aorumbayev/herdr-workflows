package history

import "testing"

func TestProgressLineVisibleFormat(t *testing.T) {
	if FormatProgressLine(ProgressLine{Index: 1, Total: 2, Label: "probe", Outcome: "start"}) != "[1/2] probe…" {
		t.Fatal("start format")
	}
	if FormatProgressLine(ProgressLine{Index: 1, Total: 2, Label: "probe", Outcome: "ok"}) != "[1/2] probe" {
		t.Fatal("ok format")
	}
	if FormatProgressLine(ProgressLine{Index: 2, Total: 2, Label: "probe", Outcome: "fail"}) != "[2/2] probe fail" {
		t.Fatal("fail format")
	}
	if FormatProgressLine(ProgressLine{Index: 3, Total: 3, Label: "run: git diff HEAD", Outcome: "skip"}) != "[3/3] run: git diff HEAD skip" {
		t.Fatal("skip format")
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
