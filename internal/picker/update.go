package picker

import (
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/update"
)

// UpdateIndicator is the list-mode filter-row hint for a newer release.
const UpdateIndicator = "[run hwf update]"

const (
	minFilterField    = 4
	filterRowOverhead = 3
)

// UpdateAvailable is true when latest is a newer strict semver than embedded.
func UpdateAvailable(embedded, latest string) bool {
	cmp, err := update.CompareSemver(embedded, latest)
	if err != nil {
		return false
	}
	return cmp < 0
}

// FormatFilterUpdateHint does not show the indicator when the filter field has no space.
func FormatFilterUpdateHint(contentWidth int) string {
	if contentWidth < filterRowOverhead+minFilterField+len(UpdateIndicator) {
		return ""
	}
	return UpdateIndicator
}

// FormatListFilterRow shows the typed filter or the placeholder, plus an update hint.
func FormatListFilterRow(filter string, contentWidth int, updateHint string) string {
	label := filter
	if label == "" {
		label = tui.FilterWorkflows
	}
	if updateHint == "" {
		return tui.Truncate(label, contentWidth)
	}
	room := contentWidth - 1 - tui.Columns(updateHint)
	if room < minFilterField {
		return tui.Truncate(label, contentWidth)
	}
	return tui.PadColumns(tui.Truncate(label, room), room) + " " + updateHint
}

// UpdateCheck is a latest-release probe that does not wait for the caller.
type UpdateCheck struct {
	Check           func() (*update.LatestRelease, error)
	EmbeddedVersion string
	OnNewer         func(version string)
}

// DefaultPickerReleaseCheck gives the GitHub latest-release probe that the picker uses.
func DefaultPickerReleaseCheck() func() (*update.LatestRelease, error) {
	return func() (*update.LatestRelease, error) {
		latest, err := update.CheckForUpdate(update.CheckOpts{})
		if err != nil {
			return nil, nil
		}
		return &latest, nil
	}
}

// StartUpdateCheck does not wait. It discards check failures.
func StartUpdateCheck(opts UpdateCheck) {
	go func() {
		latest, err := opts.Check()
		if err != nil || latest == nil {
			return
		}
		if UpdateAvailable(opts.EmbeddedVersion, latest.Version) {
			opts.OnNewer(latest.Version)
		}
	}()
}
