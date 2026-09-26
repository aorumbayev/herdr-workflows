package history

import "testing"

func TestCreateRunRecorderPersistsEntryYAML(t *testing.T) {
	_, checkout := testWriterEnv(t)
	body := "version: v1alpha1\nsteps:\n  - run: [true]\n"
	wf := demoWorkflow()
	wf.Name = "demo"
	wf.SourceYAML = body
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: wf, CheckoutRoot: checkout})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	arts, err := LoadDebugArtifacts(rec.RunID())
	if err != nil {
		t.Fatal(err)
	}
	if !arts.HasEntryYAML || arts.EntryYAML != body {
		t.Fatalf("artifacts = %+v", arts)
	}
}

func TestRecorderRecordTranscript(t *testing.T) {
	_, checkout := testWriterEnv(t)
	rec, err := CreateRunRecorder(CreateRecorderOpts{Workflow: demoWorkflow(), CheckoutRoot: checkout})
	if err != nil {
		t.Fatal(err)
	}
	defer rec.Dispose()
	hr, ok := rec.(interface{ RecordTranscript(string) })
	if !ok {
		t.Fatal("recorder missing RecordTranscript")
	}
	hr.RecordTranscript("session text")
	arts, err := LoadDebugArtifacts(rec.RunID())
	if err != nil {
		t.Fatal(err)
	}
	if !arts.HasTranscript || arts.Transcript != "session text" {
		t.Fatalf("artifacts = %+v", arts)
	}
}
