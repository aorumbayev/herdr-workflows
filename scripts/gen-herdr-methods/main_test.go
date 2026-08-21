package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGeneratedMatchesCommitted(t *testing.T) {
	generated := buildSource(
		filepath.Join("..", "..", "schemas", "herdr-api.schema.json"),
		filepath.Join("..", "..", "herdr-plugin.toml"),
	)
	committed, err := os.ReadFile(filepath.Join("..", "..", "internal", "host", "herdr_methods.gen.go"))
	if err != nil {
		t.Fatal(err)
	}
	if generated != string(committed) {
		t.Fatal("internal/host/herdr_methods.gen.go is stale — run `go run ./scripts/gen-herdr-methods`")
	}
}
