package runsbrowser

import (
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

// Load lists runs for repoRoot at scope with filter. It keeps selectedID when that id is still present.
func Load(repoRoot string, scope Scope, filter, preserveID string) State {
	filterArg := history.ListFilter{Text: filter}
	if scope == ScopeCurrent {
		root := history.CanonicalRepoRoot(repoRoot)
		filterArg.CheckoutRoot = &root
	}
	listed := history.ListRuns(filterArg)
	if !listed.OK {
		return State{
			Scope:       scope,
			Filter:      filter,
			Unavailable: true,
		}
	}
	selectedID := preserveID
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
