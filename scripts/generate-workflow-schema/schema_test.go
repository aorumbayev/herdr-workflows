package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestGeneratedSchemaMatchesCommitted(t *testing.T) {
	generatedPath := filepath.Join(t.TempDir(), "workflow.schema.json")
	if err := writeSchema(generatedPath); err != nil {
		t.Fatal(err)
	}
	generated, err := os.ReadFile(generatedPath)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile(filepath.Join("..", "..", "docs", "workflow.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(generated, committed) {
		t.Fatal("generated workflow schema differs from the committed schema")
	}
}
