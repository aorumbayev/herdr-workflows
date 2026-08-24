package cli

import (
	"errors"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/picker"
)

func TestPopupEnvCarriesState(t *testing.T) {
	t.Setenv("HERDR_WORKFLOWS_REPO_ROOT", "/repo")
	state := picker.PopupState{Tab: "console", Filter: "dep", Width: "85%", Height: "80%"}
	env := popupEnv(state)
	if env[picker.PopupStateEnv] != state.Encode() {
		t.Fatalf("state env = %q", env[picker.PopupStateEnv])
	}
	if env["HERDR_WORKFLOWS_REPO_ROOT"] != "/repo" {
		t.Fatalf("repo root missing from %v", env)
	}
	if got := picker.ParsePopupState(env[picker.PopupStateEnv]); got == nil || got.Filter != "dep" {
		t.Fatalf("round trip = %+v", got)
	}
}

func TestPopupStillOpenRetriesOnlyOnTheSingleton(t *testing.T) {
	if !popupStillOpen(errors.New("plugin_pane_open_failed: popup already open")) {
		t.Fatal("a closing popup must be retried")
	}
	if !popupStillOpen(errors.New("ui_busy: popup panes can only open from the normal workspace view")) {
		t.Fatal("a busy UI must be retried")
	}
	if popupStillOpen(errors.New("plugin_pane_not_found")) || popupStillOpen(nil) {
		t.Fatal("other failures must not retry")
	}
}
