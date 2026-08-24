package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSyncEmbedWritesByteIdenticalCopies(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range embedCopies() {
		want, err := os.ReadFile(filepath.Join(root, c.src))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(root, c.dst))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s is not byte-identical to %s; run go run ./scripts/sync-embed", c.dst, c.src)
		}
	}
}
