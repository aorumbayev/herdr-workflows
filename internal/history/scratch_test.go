package history

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

func TestScratchRoundTripAndCap(t *testing.T) {
	_, _, getenv := testWriterEnv(t)
	if err := ScratchSet("triage.last_pr", "42", getenv); err != nil {
		t.Fatal(err)
	}
	got, err := ScratchGet("triage.last_pr", getenv)
	if err != nil || got != "42" {
		t.Fatalf("get = %q err=%v", got, err)
	}
	if err := ScratchSet("run-id.b", "x", getenv); err != nil {
		t.Fatal(err)
	}
	keys, err := ScratchList(getenv)
	if err != nil || len(keys) != 2 || keys[0] != "run-id.b" || keys[1] != "triage.last_pr" {
		t.Fatalf("list = %+v err=%v", keys, err)
	}
	prev, err := ScratchGet("triage.last_pr", getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := ScratchSet("triage.last_pr", strings.Repeat("x", caps.CaptureByteLimit+1), getenv); err == nil {
		t.Fatal("over-cap set succeeded")
	}
	still, err := ScratchGet("triage.last_pr", getenv)
	if err != nil || still != prev {
		t.Fatalf("value mutated after cap: %q err=%v", still, err)
	}
	if err := ScratchDelete("run-id.b", getenv); err != nil {
		t.Fatal(err)
	}
	keys, err = ScratchList(getenv)
	if err != nil || len(keys) != 1 || keys[0] != "triage.last_pr" {
		t.Fatalf("after delete = %+v err=%v", keys, err)
	}
}
