package picker

import (
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func catalogEntries() []workflow.WorkflowListEntry {
	return []workflow.WorkflowListEntry{
		{
			Name:            "chat-handoff",
			Source:          "repo",
			File:            "/r/chat.yaml",
			Title:           "Chat handoff",
			Description:     "Pass transcript to a reviewer",
			NeedsTranscript: true,
		},
		{Name: "deploy", Source: "global", File: "/g/deploy.yaml", HasCommands: true},
		{
			Name:   "broken",
			Source: "repo",
			File:   "/r/broken.yaml",
			Error:  "/r/broken.yaml, step 2, agent: unknown agent 'x'",
		},
		{
			Name:   "chat-broken",
			Source: "global",
			File:   "/g/chat-broken.yaml",
			Error:  "cycle",
		},
	}
}

func names(entries []workflow.WorkflowListEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Name
	}
	return out
}

func TestFilterWorkflowEntriesSplitsValidAndInvalid(t *testing.T) {
	// Ports test/picker/picker.test.ts "splits valid and invalid".
	got := FilterWorkflowEntries(catalogEntries(), "")
	if want := []string{"chat-handoff", "deploy"}; !stringSlicesEqual(names(got.Valid), want) {
		t.Fatalf("valid = %v, want %v", names(got.Valid), want)
	}
	if want := []string{"broken", "chat-broken"}; !stringSlicesEqual(names(got.Invalid), want) {
		t.Fatalf("invalid = %v, want %v", names(got.Invalid), want)
	}
}

func TestFilterWorkflowEntriesSubstringAppliesToBoth(t *testing.T) {
	// Ports test/picker/picker.test.ts "substring filter applies to both".
	got := FilterWorkflowEntries(catalogEntries(), "chat")
	if want := []string{"chat-handoff"}; !stringSlicesEqual(names(got.Valid), want) {
		t.Fatalf("valid = %v, want %v", names(got.Valid), want)
	}
	if want := []string{"chat-broken"}; !stringSlicesEqual(names(got.Invalid), want) {
		t.Fatalf("invalid = %v, want %v", names(got.Invalid), want)
	}
}

func TestFilterWorkflowEntriesMatchesDisplayedTitleCaseInsensitively(t *testing.T) {
	// Ports test/picker/picker.test.ts "matches displayed title case-insensitively".
	catalog := []workflow.WorkflowListEntry{
		{Name: "pr-desc", Source: "repo", File: "/r/pr-desc.yaml", Title: "Draft PR description"},
		{Name: "handoff", Source: "global", File: "/g/handoff.yaml", Title: "Handoff"},
	}
	if got := names(FilterWorkflowEntries(catalog, "draft").Valid); !stringSlicesEqual(got, []string{"pr-desc"}) {
		t.Fatalf("draft = %v", got)
	}
	if got := names(FilterWorkflowEntries(catalog, "HANDOFF").Valid); !stringSlicesEqual(got, []string{"handoff"}) {
		t.Fatalf("HANDOFF = %v", got)
	}
}

func TestFilterWorkflowEntriesMatchesNameWhenTitleDiffers(t *testing.T) {
	// Ports test/picker/picker.test.ts "matches name when title differs".
	catalog := []workflow.WorkflowListEntry{
		{Name: "pr-desc", Source: "repo", File: "/r/pr-desc.yaml", Title: "Draft PR description"},
	}
	if got := names(FilterWorkflowEntries(catalog, "pr-desc").Valid); !stringSlicesEqual(got, []string{"pr-desc"}) {
		t.Fatalf("name match = %v", got)
	}
	if got := names(FilterWorkflowEntries(catalog, "DRAFT").Valid); !stringSlicesEqual(got, []string{"pr-desc"}) {
		t.Fatalf("title match = %v", got)
	}
}

func TestFilterWorkflowEntriesHidesHiddenWorkflows(t *testing.T) {
	// Ports test/picker/picker.test.ts "hidden workflows are kept out of the picker".
	withBg := append(append([]workflow.WorkflowListEntry{}, catalogEntries()...),
		workflow.WorkflowListEntry{Name: "ship-bg", Source: "repo", File: "/r/ship-bg.yaml", Hidden: true},
		workflow.WorkflowListEntry{Name: "broken-bg", Source: "repo", File: "/r/broken-bg.yaml", Hidden: true, Error: "boom"},
	)
	got := FilterWorkflowEntries(withBg, "")
	if want := []string{"chat-handoff", "deploy"}; !stringSlicesEqual(names(got.Valid), want) {
		t.Fatalf("valid = %v, want %v", names(got.Valid), want)
	}
	if want := []string{"broken", "chat-broken"}; !stringSlicesEqual(names(got.Invalid), want) {
		t.Fatalf("invalid = %v, want %v", names(got.Invalid), want)
	}
	if len(FilterWorkflowEntries(withBg, "bg").Valid) != 0 {
		t.Fatal("hidden entries must not match a filter")
	}
}

func TestHasVisibleEntriesFalseWhenEveryWorkflowIsHidden(t *testing.T) {
	// Ports test/picker/picker.test.ts "hasVisibleEntries is false when every workflow is hidden".
	hidden := []workflow.WorkflowListEntry{
		{Name: "ship-bg", Source: "repo", File: "/r/ship-bg.yaml", Hidden: true},
		{Name: "broken-bg", Source: "repo", File: "/r/broken-bg.yaml", Hidden: true, Error: "boom"},
	}
	if HasVisibleEntries(hidden) {
		t.Fatal("all-hidden catalog must report no visible entries")
	}
	if HasVisibleEntries(nil) {
		t.Fatal("empty catalog must report no visible entries")
	}
	if !HasVisibleEntries(append(append([]workflow.WorkflowListEntry{}, hidden...), catalogEntries()[0])) {
		t.Fatal("one visible entry must report visible")
	}
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
