package workbench

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

var (
	scopedRouteRE = regexp.MustCompile(`^(w|share)=(repo|global):([a-z0-9][a-z0-9-_]*)$`)
	runRouteRE    = regexp.MustCompile(`(?i)^run=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
)

var runStatusValues = map[string]struct{}{
	"running": {}, "stale": {}, "succeeded": {}, "failed": {},
	"interrupted": {}, "starting": {},
}

// WebRoute is a parsed workbench hash route.
type WebRoute struct {
	Kind  string
	Scope string
	Name  string
	ID    string
	Hash  string
}

// ParseWebRoute parses a hash fragment without the leading #.
func ParseWebRoute(raw string) *WebRoute {
	switch raw {
	case "import":
		return &WebRoute{Kind: "import", Hash: "import"}
	case "new":
		return &WebRoute{Kind: "new", Hash: "new"}
	}
	if strings.HasPrefix(raw, "run=") {
		m := runRouteRE.FindStringSubmatch(raw)
		if m == nil {
			return nil
		}
		id := strings.ToLower(m[1])
		return &WebRoute{Kind: "run", ID: id, Hash: "run=" + id}
	}
	m := scopedRouteRE.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	kind, scope, name := m[1], m[2], m[3]
	return &WebRoute{
		Kind:  kind,
		Scope: scope,
		Name:  name,
		Hash:  kind + "=" + scope + ":" + name,
	}
}

type openWorkflow struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

type runLocation struct {
	ID    string  `json:"id"`
	Label string  `json:"label"`
	Root  *string `json:"root"`
}

func parseRunStatuses(statusParam string) []string {
	if statusParam == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(statusParam, ",") {
		s := strings.TrimSpace(part)
		if _, ok := runStatusValues[s]; ok {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func resolveOpenWorkflow(repoRoot, checkoutRoot, workflowName, source string) *openWorkflow {
	if checkoutRoot == "" || workflowName == "" || source == "" {
		return nil
	}
	if history.CanonicalRepoRoot(checkoutRoot) != history.CanonicalRepoRoot(repoRoot) {
		return nil
	}
	entries, err := workflow.ListWorkflows(repoRoot)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if entry.Name == workflowName && entry.Source == source && entry.Error == "" {
			return &openWorkflow{Name: entry.Name, Source: entry.Source}
		}
	}
	return nil
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	location := r.URL.Query().Get("location")
	text := r.URL.Query().Get("q")
	if text == "" {
		text = r.URL.Query().Get("text")
	}
	filter := history.ListFilter{
		Text:   text,
		Status: parseRunStatuses(r.URL.Query().Get("status")),
	}
	switch location {
	case "all", "*":
		filter.CheckoutRoot = nil
	case "", "current":
		root := history.CanonicalRepoRoot(s.repoRoot)
		filter.CheckoutRoot = &root
	default:
		root := location
		filter.CheckoutRoot = &root
	}
	listed := history.ListRuns(filter, nil)
	if !listed.OK {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "unavailable": true, "runs": []any{}, "locations": []any{},
		})
		return
	}
	allRoot := (*string)(nil)
	locations := []runLocation{
		{ID: "current", Label: "Current", Root: &s.repoRoot},
		{ID: "all", Label: "All folders", Root: allRoot},
	}
	for _, root := range listed.CheckoutRoots {
		if root == s.repoRoot {
			continue
		}
		copyRoot := root
		locations = append(locations, runLocation{ID: root, Label: root, Root: &copyRoot})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"runs":          listed.Runs,
		"locations":     locations,
		"checkout_root": s.repoRoot,
	})
}

func (s *Server) handleRunDetail(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	presented := history.RunDetail(id, nil, time.Time{})
	detail := presented.Detail
	blocks := presented.Blocks

	switch detail.Kind {
	case "invalid":
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "detail": encodeDetail(detail, nil), "blocks": encodeBlocks(blocks),
		})
	case "unavailable":
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "detail": encodeDetail(detail, nil), "blocks": encodeBlocks(blocks),
		})
	case "missing":
		writeJSON(w, http.StatusNotFound, map[string]any{
			"ok": false, "detail": encodeDetail(detail, nil), "blocks": encodeBlocks(blocks),
		})
	case "expired":
		writeJSON(w, http.StatusGone, map[string]any{
			"ok": false, "detail": encodeDetail(detail, nil), "blocks": encodeBlocks(blocks),
		})
	case "incompatible":
		writeJSON(w, http.StatusConflict, map[string]any{
			"ok": false, "detail": encodeDetail(detail, nil), "blocks": encodeBlocks(blocks),
		})
	default:
		open := resolveOpenWorkflow(s.repoRoot, detail.CheckoutRoot, detail.Workflow, detail.Source)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "detail": encodeDetail(detail, open), "blocks": encodeBlocks(blocks),
		})
	}
}

func encodeDetail(d history.Detail, open *openWorkflow) map[string]any {
	switch d.Kind {
	case "invalid":
		return map[string]any{"kind": "invalid", "message": d.Message}
	case "missing":
		return map[string]any{"kind": "missing", "id": d.ID, "message": d.Message}
	case "expired":
		return map[string]any{"kind": "expired", "id": d.ID, "message": d.Message}
	case "incompatible":
		return map[string]any{"kind": "incompatible", "id": d.ID, "message": d.Message}
	case "unavailable":
		out := map[string]any{"kind": "unavailable", "message": d.Message}
		if d.ID != "" {
			out["id"] = d.ID
		}
		return out
	}
	out := map[string]any{
		"kind":          "snapshot",
		"id":            d.ID,
		"display_id":    d.DisplayID,
		"workflow":      d.Workflow,
		"source":        d.Source,
		"checkout_root": d.CheckoutRoot,
		"status":        d.Status,
		"started_at":    d.StartedAt,
		"heartbeat_at":  d.HeartbeatAt,
		"elapsed_ms":    d.ElapsedMs,
		"steps":         encodeDetailSteps(d.Steps),
	}
	if d.Title != "" {
		out["title"] = d.Title
	}
	if d.FinishedAt != "" {
		out["finished_at"] = d.FinishedAt
	}
	if d.CurrentStep != nil {
		out["current_step"] = encodeDetailStep(*d.CurrentStep)
	}
	if d.Remaining != nil {
		out["remaining"] = *d.Remaining
	}
	if d.FailureExplanation != "" {
		out["failure_explanation"] = d.FailureExplanation
	}
	if open != nil {
		out["open_workflow"] = open
	}
	return out
}

func encodeDetailSteps(steps []history.DetailStep) []map[string]any {
	out := make([]map[string]any, len(steps))
	for i, step := range steps {
		out[i] = encodeDetailStep(step)
	}
	return out
}

func encodeDetailStep(step history.DetailStep) map[string]any {
	out := map[string]any{
		"phase":         step.Phase,
		"workflow":      step.Workflow,
		"workflow_path": step.WorkflowPath,
		"ordinal":       step.Ordinal,
		"total":         step.Total,
		"action":        step.Action,
		"label":         step.Label,
	}
	if step.StepID != "" {
		out["step_id"] = step.StepID
	}
	if step.ParentOrdinal != nil {
		out["parent_ordinal"] = *step.ParentOrdinal
	}
	if step.StartedAt != "" {
		out["started_at"] = step.StartedAt
	}
	if step.FinishedAt != "" {
		out["finished_at"] = step.FinishedAt
	}
	if step.Outcome != "" {
		out["outcome"] = step.Outcome
	}
	if step.Truncated {
		out["truncated"] = true
	}
	if step.Failure != nil {
		out["failure"] = step.Failure
	}
	if step.Explanation != "" {
		out["explanation"] = step.Explanation
	}
	if step.Active {
		out["active"] = true
	}
	return out
}

func encodeBlocks(blocks []history.Block) []map[string]any {
	out := make([]map[string]any, len(blocks))
	for i, b := range blocks {
		m := map[string]any{"kind": b.Kind}
		switch b.Kind {
		case "head":
			m["status"] = b.Status
			m["title"] = b.Title
			m["display_id"] = b.DisplayID
			m["elapsed"] = b.Elapsed
		case "note", "error":
			m["text"] = b.Text
		case "step":
			m["depth"] = b.Depth
			m["ordinal"] = b.Ordinal
			m["total"] = b.Total
			m["label"] = b.Label
			m["outcome"] = b.Outcome
			if b.Explanation != "" {
				m["explanation"] = b.Explanation
			}
		}
		out[i] = m
	}
	return out
}
