package history

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const (
	StaleAfter     = 15 * time.Second
	RetentionBytes = 512_000
	listLimit      = 40
)

type ListFilter struct {
	CheckoutRoot *string
	Text         string
	Status       []string
	Now          time.Time
}

type ListResult struct {
	OK            bool
	Unavailable   bool
	Runs          []Summary
	Incompatible  []IncompatibleSnapshot
	CheckoutRoots []string
}

type IncompatibleSnapshot struct {
	ID      string
	Version int
}

type Summary struct {
	ID           string       `json:"id"`
	DisplayID    string       `json:"display_id"`
	Workflow     string       `json:"workflow"`
	Title        string       `json:"title,omitempty"`
	Source       string       `json:"source"`
	CheckoutRoot string       `json:"checkout_root"`
	Status       string       `json:"status"`
	StartedAt    string       `json:"started_at"`
	FinishedAt   string       `json:"finished_at,omitempty"`
	ElapsedMs    int64        `json:"elapsed_ms"`
	Progress     *Progress    `json:"progress,omitempty"`
	CurrentLabel string       `json:"current_label,omitempty"`
	StepLabels   []string     `json:"step_labels,omitempty"`
	Failure      *FailureFact `json:"failure,omitempty"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

func ListRuns(filter ListFilter, getenv config.Env) ListResult {
	if _, err := ensureRunsDir(getenv); err != nil {
		return ListResult{Unavailable: true}
	}
	now := filter.Now
	if now.IsZero() {
		now = time.Now()
	}
	snaps, incompat, err := loadAllSnapshots(getenv)
	if err != nil {
		return ListResult{Unavailable: true}
	}
	items := make([]Summary, 0, len(snaps))
	roots := map[string]struct{}{}
	for _, snap := range snaps {
		items = append(items, ToSummary(snap, now))
		roots[snap.CheckoutRoot] = struct{}{}
	}
	checkout := filter.CheckoutRoot
	if checkout != nil {
		canon := CanonicalRepoRoot(*checkout)
		checkout = &canon
	}
	runs := filterSortLimit(items, ListFilter{
		CheckoutRoot: checkout,
		Text:         filter.Text,
		Status:       filter.Status,
		Now:          now,
	})
	checkoutRoots := make([]string, 0, len(roots))
	for r := range roots {
		checkoutRoots = append(checkoutRoots, r)
	}
	slices.Sort(checkoutRoots)
	return ListResult{OK: true, Runs: runs, Incompatible: incompat, CheckoutRoots: checkoutRoots}
}

func CanonicalRepoRoot(repoRoot string) string {
	if resolved, err := filepath.EvalSymlinks(repoRoot); err == nil {
		return resolved
	}
	return repoRoot
}

func loadAllSnapshots(getenv config.Env) ([]Snapshot, []IncompatibleSnapshot, error) {
	dir := RunsDir(getenv)
	names, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	var out []Snapshot
	var incompat []IncompatibleSnapshot
	for _, name := range names {
		n := name.Name()
		if !strings.HasSuffix(n, ".json") || strings.HasPrefix(n, ".") {
			continue
		}
		id := strings.TrimSuffix(n, ".json")
		loaded, err := loadSnapshot(id, getenv)
		if err != nil {
			return nil, nil, err
		}
		if loaded.Incompatible != nil {
			incompat = append(incompat, *loaded.Incompatible)
			continue
		}
		if loaded.Snap != nil {
			out = append(out, *loaded.Snap)
		}
	}
	return out, incompat, nil
}

func filterSortLimit(items []Summary, filter ListFilter) []Summary {
	matched := make([]Summary, 0, len(items))
	for _, item := range items {
		if matchesListFilter(item, filter) {
			matched = append(matched, item)
		}
	}
	slices.SortFunc(matched, func(a, b Summary) int {
		at, _ := parseISOTime(a.StartedAt)
		bt, _ := parseISOTime(b.StartedAt)
		if !at.Equal(bt) {
			if bt.After(at) {
				return 1
			}
			return -1
		}
		return strings.Compare(b.ID, a.ID)
	})
	if len(matched) > listLimit {
		matched = matched[:listLimit]
	}
	return matched
}

func matchesListFilter(item Summary, filter ListFilter) bool {
	if filter.CheckoutRoot != nil && item.CheckoutRoot != *filter.CheckoutRoot {
		return false
	}
	if len(filter.Status) > 0 && !slices.Contains(filter.Status, item.Status) {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(filter.Text))
	if text != "" && !strings.Contains(searchableText(item), text) {
		return false
	}
	return true
}

func searchableText(item Summary) string {
	parts := []string{
		item.Workflow, item.Title, item.ID, item.DisplayID, item.Status,
		item.CurrentLabel, item.Source, item.CheckoutRoot,
	}
	parts = append(parts, item.StepLabels...)
	if item.Failure != nil {
		parts = append(parts, item.Failure.Action, item.Failure.Method, item.Failure.StepID, item.Failure.Coordination)
		if item.Failure.ExitCode != nil {
			parts = append(parts, strconv.Itoa(*item.Failure.ExitCode))
		}
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

func retentionCleanup(getenv config.Env) error {
	dir := RunsDir(getenv)
	names, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type term struct {
		id      string
		path    string
		size    int64
		started time.Time
	}
	var terminals []term
	var bytes int64
	for _, name := range names {
		n := name.Name()
		if !strings.HasSuffix(n, ".json") || strings.HasPrefix(n, ".") {
			continue
		}
		id := strings.TrimSuffix(n, ".json")
		path := SnapshotPath(id, getenv)
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		snap, err := ReadSnapshot(id, getenv)
		if err != nil || snap == nil || snap.Status == "" {
			continue
		}
		started, _ := parseISOTime(snap.StartedAt)
		terminals = append(terminals, term{id: id, path: path, size: info.Size(), started: started})
		bytes += info.Size()
	}
	if bytes <= RetentionBytes {
		return nil
	}
	slices.SortFunc(terminals, func(a, b term) int {
		if !a.started.Equal(b.started) {
			if a.started.Before(b.started) {
				return -1
			}
			return 1
		}
		return strings.Compare(a.id, b.id)
	})
	for bytes > RetentionBytes && len(terminals) > 1 {
		oldest := terminals[0]
		terminals = terminals[1:]
		_ = os.Remove(oldest.path)
		removeDebugArtifacts(oldest.id, getenv)
		_ = os.WriteFile(filepath.Join(dir, oldest.id+".expired"), []byte{}, 0o600)
		bytes -= oldest.size
	}
	return nil
}
