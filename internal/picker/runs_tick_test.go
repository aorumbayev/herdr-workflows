package picker

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

func writeRunningRun(t *testing.T, getenv config.Env, checkout, workflow, startedAt string) {
	t.Helper()
	w := history.NewWriter(getenv)
	claimed := w.Claim(history.ClaimMeta{Workflow: workflow, Source: "repo", CheckoutRoot: checkout, StartedAt: startedAt})
	if !claimed.OK || claimed.State != "claimed" {
		t.Fatalf("claim = %+v", claimed)
	}
	w.Dispose()
}

func TestPickerForwardsRunsTickToEmbeddedModel(t *testing.T) {
	stateDir := t.TempDir()
	checkout := t.TempDir()
	getenv := func(key string) string {
		if key == "HERDR_PLUGIN_STATE_DIR" {
			return stateDir
		}
		return os.Getenv(key)
	}
	started := time.Now().UTC()
	writeRunningRun(t, getenv, checkout, "live", started.Format("2006-01-02T15:04:05.000Z"))

	var now time.Time
	now = started.Add(2 * time.Second)
	m := New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: checkout, Env: getenv, Now: func() time.Time { return now }})

	next, cmd := m.Update(press("tab"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("entering the runs tab must load the list")
	}
	msg := cmd()
	next, cmd = m.Update(msg)
	m = next.(Model)
	if cmd == nil {
		t.Fatal("picker did not forward the runs list-load to arm the embedded ticker")
	}
	body := m.View().Content
	if !strings.Contains(body, "live") || !strings.Contains(body, "2s") {
		t.Fatalf("running run elapsed missing through the picker:\n%s", body)
	}
	now = started.Add(5 * time.Second)
	advanced := m.View().Content
	if !strings.Contains(advanced, "5s") || advanced == body {
		t.Fatalf("elapsed did not advance through the picker Body:\n%s", advanced)
	}
}
