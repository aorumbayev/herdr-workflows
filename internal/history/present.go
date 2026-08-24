package history

import (
	"fmt"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

type Detail struct {
	Kind               string
	Message            string
	ID                 string
	DisplayID          string
	Workflow           string
	Title              string
	Source             string
	CheckoutRoot       string
	Status             string
	StartedAt          string
	FinishedAt         string
	HeartbeatAt        string
	ElapsedMs          int64
	CurrentStep        *DetailStep
	Steps              []DetailStep
	Remaining          *int
	FailureExplanation string
}

type DetailStep struct {
	StepRecord
	Active bool
}

type Block struct {
	Kind        string
	Status      string
	Title       string
	DisplayID   string
	Elapsed     string
	Text        string
	Depth       int
	Ordinal     int
	Total       int
	Label       string
	Outcome     string
	Explanation string
}

type PresentedDetail struct {
	Detail Detail
	Blocks []Block
}

func ToDetail(snap Snapshot, now time.Time) Detail {
	if now.IsZero() {
		now = time.Now()
	}
	status := ProjectStatus(snap, now)
	steps := orderDetailSteps(detailStepsFromRecords(snap.Steps))
	var current *DetailStep
	if snap.CurrentStep != nil {
		cs := DetailStep{StepRecord: StepRecord{
			StepIdentity: snap.CurrentStep.StepIdentity,
			StartedAt:    snap.CurrentStep.StartedAt,
		}, Active: true}
		current = &cs
	}
	expl := snap.FailureExplanation
	for i := len(snap.Steps) - 1; i >= 0; i-- {
		if snap.Steps[i].Explanation != "" {
			expl = snap.Steps[i].Explanation
			break
		}
	}
	d := Detail{
		Kind:               "snapshot",
		ID:                 snap.ID,
		DisplayID:          DisplayRunID(snap.ID),
		Workflow:           snap.Workflow,
		Title:              snap.Title,
		Source:             snap.Source,
		CheckoutRoot:       snap.CheckoutRoot,
		Status:             status,
		StartedAt:          snap.StartedAt,
		FinishedAt:         snap.FinishedAt,
		HeartbeatAt:        snap.HeartbeatAt,
		ElapsedMs:          elapsedMs(snap, status, now),
		CurrentStep:        current,
		Steps:              steps,
		FailureExplanation: expl,
	}
	if rem := remainingCount(snap); rem != nil {
		d.Remaining = rem
	}
	return d
}

func remainingCount(snap Snapshot) *int {
	if snap.Status == "" || snap.Status == "succeeded" {
		return nil
	}
	entryMain := 0
	total := 0
	has := false
	for _, step := range snap.Steps {
		if step.Workflow == snap.Workflow && step.Phase == "main" {
			entryMain++
			if !has || step.Total > total {
				total = step.Total
				has = true
			}
		}
	}
	if !has {
		return nil
	}
	remaining := total - entryMain
	if remaining > 0 {
		return &remaining
	}
	return nil
}

func detailStepsFromRecords(steps []StepRecord) []DetailStep {
	out := make([]DetailStep, len(steps))
	for i, step := range steps {
		out[i] = DetailStep{StepRecord: step}
	}
	return out
}

func isNestedUnder(parentPath, childPath []string) bool {
	if len(childPath) <= len(parentPath) {
		return false
	}
	for i, part := range parentPath {
		if childPath[i] != part {
			return false
		}
	}
	return true
}

func belongsToWrapper(parent, child DetailStep) bool {
	if child.Phase == "recovery" || child.ParentOrdinal == nil {
		return false
	}
	if *child.ParentOrdinal != parent.Ordinal {
		return false
	}
	return isNestedUnder(parent.WorkflowPath, child.WorkflowPath)
}

func orderDetailSteps(steps []DetailStep) []DetailStep {
	if len(steps) <= 1 {
		return steps
	}
	out := make([]DetailStep, 0, len(steps))
	used := make([]bool, len(steps))
	var emit func(int)
	emit = func(index int) {
		if used[index] {
			return
		}
		used[index] = true
		parent := steps[index]
		out = append(out, parent)
		if parent.Action != "workflow" {
			return
		}
		type pair struct {
			step DetailStep
			i    int
		}
		var children []pair
		for i, step := range steps {
			if !used[i] && belongsToWrapper(parent, step) {
				children = append(children, pair{step, i})
			}
		}
		for i := 0; i < len(children); i++ {
			for j := i + 1; j < len(children); j++ {
				a, b := children[i], children[j]
				if len(a.step.WorkflowPath) != len(b.step.WorkflowPath) {
					if len(a.step.WorkflowPath) > len(b.step.WorkflowPath) {
						children[i], children[j] = b, a
					}
					continue
				}
				if a.step.Ordinal != b.step.Ordinal {
					if a.step.Ordinal > b.step.Ordinal {
						children[i], children[j] = b, a
					}
					continue
				}
				if a.i > b.i {
					children[i], children[j] = b, a
				}
			}
		}
		for _, child := range children {
			if len(child.step.WorkflowPath) == len(parent.WorkflowPath)+1 {
				emit(child.i)
			}
		}
		for _, child := range children {
			emit(child.i)
		}
	}
	topLen := len(steps[0].WorkflowPath)
	for _, step := range steps {
		if len(step.WorkflowPath) < topLen {
			topLen = len(step.WorkflowPath)
		}
	}
	type pair struct {
		step DetailStep
		i    int
	}
	var tops []pair
	for i, step := range steps {
		if len(step.WorkflowPath) == topLen {
			tops = append(tops, pair{step, i})
		}
	}
	for i := 0; i < len(tops); i++ {
		for j := i + 1; j < len(tops); j++ {
			if tops[i].step.Ordinal > tops[j].step.Ordinal || (tops[i].step.Ordinal == tops[j].step.Ordinal && tops[i].i > tops[j].i) {
				tops[i], tops[j] = tops[j], tops[i]
			}
		}
	}
	for _, top := range tops {
		emit(top.i)
	}
	for i := range steps {
		emit(i)
	}
	return out
}

func StatusLabel(status string) string {
	switch status {
	case "running":
		return "RUNNING"
	case "stale":
		return "STALE"
	case "succeeded":
		return "SUCCEEDED"
	case "failed":
		return "FAILED"
	case "interrupted":
		return "INTERRUPTED"
	default:
		return "STARTING"
	}
}

func FormatElapsed(ms int64) string {
	sec := ms / 1000
	if sec < 60 {
		return fmt.Sprintf("%ds", sec)
	}
	min := sec / 60
	if min < 60 {
		if sec%60 != 0 {
			return fmt.Sprintf("%dm%ds", min, sec%60)
		}
		return fmt.Sprintf("%dm", min)
	}
	hr := min / 60
	if min%60 != 0 {
		return fmt.Sprintf("%dh%dm", hr, min%60)
	}
	return fmt.Sprintf("%dh", hr)
}

func PresentRunDetail(detail Detail) []Block {
	switch detail.Kind {
	case "invalid":
		msg := detail.Message
		if msg == "" {
			msg = "invalid run"
		}
		return []Block{{Kind: "error", Text: msg}}
	case "missing":
		msg := detail.Message
		if msg == "" {
			msg = "run not found"
		}
		return []Block{{Kind: "error", Text: msg}}
	case "expired":
		msg := detail.Message
		if msg == "" {
			msg = "run expired"
		}
		return []Block{{Kind: "error", Text: msg}}
	case "unavailable":
		msg := detail.Message
		if msg == "" {
			msg = "history unavailable"
		}
		return []Block{{Kind: "error", Text: msg}}
	case "incompatible":
		msg := detail.Message
		if msg == "" {
			msg = "run snapshot is incompatible"
		}
		return []Block{{Kind: "error", Text: msg}}
	}
	title := detail.Title
	if title == "" {
		title = detail.Workflow
	}
	blocks := []Block{{
		Kind:      "head",
		Status:    StatusLabel(detail.Status),
		Title:     title,
		DisplayID: detail.DisplayID,
		Elapsed:   FormatElapsed(detail.ElapsedMs),
	}, {Kind: "note", Text: detail.CheckoutRoot}}
	if detail.Status == "stale" {
		blocks = append(blocks, Block{Kind: "note", Text: "writer heartbeat stale - not a failure"})
	}
	hasSteps := len(detail.Steps) > 0 || (detail.CurrentStep != nil && detail.CurrentStep.Active)
	hasRemaining := detail.Remaining != nil && *detail.Remaining > 0
	hasFailure := detail.FailureExplanation != ""
	for _, step := range detail.Steps {
		if step.Explanation != "" {
			hasFailure = false
			break
		}
	}
	for _, step := range detail.Steps {
		depth := len(step.WorkflowPath) - 1
		if depth < 0 {
			depth = 0
		}
		base := step.Outcome
		if base == "" && step.Active {
			base = "running"
		}
		outcome := base
		if step.Truncated {
			outcome = base + " (truncated read)"
		}
		b := Block{Kind: "step", Depth: depth, Ordinal: step.Ordinal, Total: step.Total, Label: step.Label, Outcome: outcome}
		if step.Explanation != "" {
			b.Explanation = step.Explanation
		}
		blocks = append(blocks, b)
	}
	if detail.CurrentStep != nil && detail.CurrentStep.Active {
		step := detail.CurrentStep
		depth := len(step.WorkflowPath) - 1
		if depth < 0 {
			depth = 0
		}
		blocks = append(blocks, Block{Kind: "step", Depth: depth, Ordinal: step.Ordinal, Total: step.Total, Label: step.Label, Outcome: "running"})
	}
	if hasRemaining {
		noun := "steps"
		if *detail.Remaining == 1 {
			noun = "step"
		}
		blocks = append(blocks, Block{Kind: "note", Text: fmt.Sprintf("%d %s not run", *detail.Remaining, noun)})
	}
	if hasFailure {
		blocks = append(blocks, Block{Kind: "error", Text: detail.FailureExplanation})
	}
	if !hasSteps && !hasRemaining && !hasFailure {
		blocks = append(blocks, Block{Kind: "note", Text: "no step outcomes yet"})
	}
	return blocks
}

func PresentDetail(detail Detail) PresentedDetail {
	return PresentedDetail{Detail: detail, Blocks: PresentRunDetail(detail)}
}

func RunDetail(id string, getenv config.Env, now time.Time) PresentedDetail {
	return PresentDetail(loadRunDetail(id, getenv, now))
}

func loadRunDetail(id string, getenv config.Env, now time.Time) Detail {
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return Detail{Kind: "invalid", Message: "run link is not a complete UUID"}
	}
	loaded, err := loadSnapshot(normalized, getenv)
	if err != nil {
		return Detail{Kind: "unavailable", ID: normalized, Message: "run history storage is unavailable"}
	}
	if loaded.Incompatible != nil {
		return Detail{
			Kind:    "incompatible",
			ID:      normalized,
			Message: fmt.Sprintf("run snapshot version %d is incompatible", loaded.Incompatible.Version),
		}
	}
	if loaded.Expired {
		return Detail{Kind: "expired", ID: normalized, Message: "run record expired"}
	}
	if loaded.Snap == nil {
		return Detail{Kind: "missing", ID: normalized, Message: "run record not found"}
	}
	return ToDetail(*loaded.Snap, now)
}
