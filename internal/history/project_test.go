package history

import "testing"

func TestDisplayRunID(t *testing.T) {
	if got := DisplayRunID("550e8400-e29b-41d4-a716-446655440099"); got != "550e8400" {
		t.Fatalf("uuid = %q", got)
	}
	if got := DisplayRunID("abc"); got != "abc" {
		t.Fatalf("short = %q", got)
	}
	if got := DisplayRunID("12345678"); got != "12345678" {
		t.Fatalf("exact8 = %q", got)
	}
	if got := DisplayRunID("123456789"); got != "12345678" {
		t.Fatalf("nine = %q", got)
	}
}
