package history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCreateRunRecorderPersistsEntryYAML(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	dir := filepath.Join(checkout, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "version: v1alpha1\nsteps:\n  - run: [true]\n"
	path := filepath.Join(dir, "demo.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	wf := demoWorkflow()
	wf.Name = "demo"
	wf.File = path
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: wf, CheckoutRoot: checkout, Getenv: getenv})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	arts, err := LoadDebugArtifacts(rec.RunID(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	if !arts.HasEntryYAML || arts.EntryYAML != body {
		t.Fatalf("artifacts = %+v", arts)
	}
}

func TestRecorderRecordTranscript(t *testing.T) {
	_, checkout, getenv := testWriterEnv(t)
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: demoWorkflow(), CheckoutRoot: checkout, Getenv: getenv})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	hr, ok := rec.(interface{ RecordTranscript(string) })
	if !ok {
		t.Fatal("recorder missing RecordTranscript")
	}
	hr.RecordTranscript("session text")
	arts, err := LoadDebugArtifacts(rec.RunID(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	if !arts.HasTranscript || arts.Transcript != "session text" {
		t.Fatalf("artifacts = %+v", arts)
	}
}
