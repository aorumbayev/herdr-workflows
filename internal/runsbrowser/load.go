package runsbrowser

import (
	"os"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

// Load lists runs for repoRoot at scope with filter, preserving selectedID when still present.
func Load(repoRoot string, scope Scope, filter, preserveID string, getenv config.Env) State {
	if getenv == nil {
		getenv = os.Getenv
	}
	filterArg := history.ListFilter{Text: filter}
	if scope == ScopeCurrent {
		root := history.CanonicalRepoRoot(repoRoot)
		filterArg.CheckoutRoot = &root
	}
	listed := history.ListRuns(filterArg, getenv)
	if !listed.OK {
		return State{
			Scope:       scope,
			Filter:      filter,
			Unavailable: true,
		}
	}
	selectedID := preserveID
	if selectedID != "" {
		found := false
		for _, run := range listed.Runs {
			if run.ID == selectedID {
				found = true
				break
			}
		}
		if !found {
			selectedID = ""
		}
	}
	if selectedID == "" && len(listed.Runs) > 0 {
		selectedID = listed.Runs[0].ID
	}
	return State{
		Scope:          scope,
		Filter:         filter,
		Items:          listed.Runs,
		SelectedID:     selectedID,
		HasMachineRuns: len(listed.CheckoutRoots) > 0,
	}
}
