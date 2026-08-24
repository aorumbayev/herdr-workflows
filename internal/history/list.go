package history

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const (
	StaleAfter = 15 * time.Second
	listLimit  = 40
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
	now := filter.Now
	if now.IsZero() {
		now = time.Now()
	}
	items, incompat, roots, err := listRunSummaries(now, getenv)
	if err != nil {
		return ListResult{Unavailable: true}
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
	slices.Sort(roots)
	return ListResult{OK: true, Runs: runs, Incompatible: incompat, CheckoutRoots: roots}
}

func CanonicalRepoRoot(repoRoot string) string {
	if resolved, err := filepath.EvalSymlinks(repoRoot); err == nil {
		return resolved
	}
	return repoRoot
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
