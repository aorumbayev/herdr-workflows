package history

import (
	"encoding/base64"
	"errors"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	StaleAfter       = 15 * time.Second
	DefaultListLimit = 40
	MaxListLimit     = 200
)

// Statuses are the five projected run statuses, in the order the docs list them.
var Statuses = []string{"running", "stale", "succeeded", "failed", "interrupted"}

type ListFilter struct {
	CheckoutRoot *string
	Text         string
	Status       []string
	Now          time.Time
	Limit        int
	After        *Cursor
}

type ListResult struct {
	OK                 bool
	Unavailable        bool
	IncompatibleSchema int
	Runs               []Summary
	NextCursor         *Cursor
	Malformed          int
	Incompatible       []IncompatibleSnapshot
	CheckoutRoots      []string
}

type IncompatibleSnapshot struct {
	ID      string
	Version int
}

// Cursor is a keyset position in the (started_at desc, id desc) order.
type Cursor struct {
	StartedAt string
	ID        string
}

func (c Cursor) Encode() string {
	return base64.RawURLEncoding.EncodeToString([]byte(c.StartedAt + "|" + c.ID))
}

func DecodeCursor(token string) (Cursor, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(token))
	if err != nil {
		return Cursor{}, false
	}
	started, id, ok := strings.Cut(string(raw), "|")
	if !ok || !isISOTimestamp(started) {
		return Cursor{}, false
	}
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return Cursor{}, false
	}
	return Cursor{StartedAt: started, ID: normalized}, true
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
	HeartbeatAt  string       `json:"heartbeat_at,omitempty"`
	FinishedAt   string       `json:"finished_at,omitempty"`
	ElapsedMs    int64        `json:"elapsed_ms"`
	Progress     *Progress    `json:"progress,omitempty"`
	CurrentStep  *CurrentStep `json:"current_step,omitempty"`
	StepLabels   []string     `json:"step_labels"`
	Failure      *FailureFact `json:"failure,omitempty"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

func ListRuns(filter ListFilter) ListResult {
	now := filter.Now
	if now.IsZero() {
		now = time.Now()
	}
	rows, err := listRunSummaries(now)
	if err != nil {
		var incompatible *IncompatibleHistoryError
		if errors.As(err, &incompatible) {
			return ListResult{IncompatibleSchema: incompatible.Version}
		}
		return ListResult{Unavailable: true}
	}
	checkout := filter.CheckoutRoot
	if checkout != nil {
		canon := CanonicalRepoRoot(*checkout)
		checkout = &canon
	}
	filter.CheckoutRoot = checkout
	filter.Now = now
	runs, next := filterSortPage(rows.Items, filter)
	slices.Sort(rows.CheckoutRoots)
	return ListResult{
		OK:            true,
		Runs:          runs,
		NextCursor:    next,
		Malformed:     rows.Malformed,
		Incompatible:  rows.Incompatible,
		CheckoutRoots: rows.CheckoutRoots,
	}
}

func CanonicalRepoRoot(repoRoot string) string {
	if resolved, err := filepath.EvalSymlinks(repoRoot); err == nil {
		return resolved
	}
	return repoRoot
}

func filterSortPage(items []Summary, filter ListFilter) ([]Summary, *Cursor) {
	matched := make([]Summary, 0, len(items))
	for _, item := range items {
		if matchesListFilter(item, filter) {
			matched = append(matched, item)
		}
	}
	slices.SortFunc(matched, compareNewestFirst)
	if filter.After != nil {
		after := Summary{StartedAt: filter.After.StartedAt, ID: filter.After.ID}
		for len(matched) > 0 && compareNewestFirst(matched[0], after) <= 0 {
			matched = matched[1:]
		}
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if len(matched) <= limit {
		return matched, nil
	}
	page := matched[:limit]
	last := page[len(page)-1]
	return page, &Cursor{StartedAt: last.StartedAt, ID: last.ID}
}

func compareNewestFirst(a, b Summary) int {
	at, _ := parseISOTime(a.StartedAt)
	bt, _ := parseISOTime(b.StartedAt)
	if !at.Equal(bt) {
		if bt.After(at) {
			return 1
		}
		return -1
	}
	return strings.Compare(b.ID, a.ID)
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
		item.Source, item.CheckoutRoot,
	}
	if item.CurrentStep != nil {
		parts = append(parts, item.CurrentStep.Label)
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
