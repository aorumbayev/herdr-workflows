package history

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
)

type ClaimMeta struct {
	ID           string
	Workflow     string
	Title        string
	Source       string
	CheckoutRoot string
	StartedAt    string
}

type ClaimResult struct {
	OK    bool
	State string
	ID    string
	Error string
}

type Writer struct {
	getenv    config.Env
	mu        sync.Mutex
	snapshot  *Snapshot
	available bool
	hbStop    chan struct{}
}

func NewWriter(getenv config.Env) *Writer {
	if getenv == nil {
		getenv = os.Getenv
	}
	return &Writer{getenv: getenv}
}

func (w *Writer) ID() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.snapshot == nil {
		return ""
	}
	return w.snapshot.ID
}

func (w *Writer) Dispose() {
	w.mu.Lock()
	w.stopHeartbeatLocked()
	w.mu.Unlock()
}

func AllocateRunID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func NormalizeRunUUID(raw string) (string, bool) {
	id := strings.ToLower(strings.TrimSpace(raw))
	if !engine.ValidRunID(id) {
		return "", false
	}
	return id, true
}

func (w *Writer) Claim(meta ClaimMeta) ClaimResult {
	var id string
	if meta.ID != "" {
		normalized, ok := NormalizeRunUUID(meta.ID)
		if !ok {
			return ClaimResult{State: "rejected", Error: "run identity must be a complete UUID"}
		}
		id = normalized
	} else {
		id = AllocateRunID()
	}
	started := meta.StartedAt
	if started == "" {
		started = nowISO()
	}
	checkout, err := filepath.EvalSymlinks(meta.CheckoutRoot)
	if err != nil {
		return ClaimResult{OK: true, State: "unavailable", ID: id}
	}
	snap := Snapshot{
		Version:      SnapshotVersion,
		ID:           id,
		Workflow:     meta.Workflow,
		Title:        meta.Title,
		Source:       meta.Source,
		CheckoutRoot: checkout,
		StartedAt:    started,
		HeartbeatAt:  started,
		Steps:        []StepRecord{},
	}
	if err := insertClaim(snap, w.getenv); err != nil {
		if isUniqueConstraint(err) {
			return ClaimResult{
				State: "rejected",
				Error: fmt.Sprintf("run identity '%s' is already claimed", id),
				ID:    id,
			}
		}
		return ClaimResult{OK: true, State: "unavailable", ID: id}
	}
	w.mu.Lock()
	w.snapshot = &snap
	w.available = true
	w.startHeartbeatLocked()
	w.mu.Unlock()
	_ = retentionCleanup(w.getenv)
	return ClaimResult{OK: true, State: "claimed", ID: id}
}

type FinalizeOpts struct {
	Returns any
	Error   string
}

func (w *Writer) Touch() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.available || w.snapshot == nil || w.snapshot.Status != "" {
		return
	}
	at := nowISO()
	w.snapshot.HeartbeatAt = at
	_ = updateHeartbeat(w.snapshot.ID, at, w.getenv)
}

func (w *Writer) SetCurrentStep(step CurrentStep) {
	w.mutateLive(func(snap *Snapshot) {
		cur := step
		snap.CurrentStep = &cur
	})
}

func (w *Writer) RecordStep(step StepRecord) {
	w.mutateLive(func(snap *Snapshot) {
		snap.CurrentStep = nil
		snap.Steps = append(snap.Steps, step)
	})
}

func (w *Writer) Finalize(status string, opts FinalizeOpts) {
	w.mu.Lock()
	w.stopHeartbeatLocked()
	defer w.mu.Unlock()
	if !w.available || w.snapshot == nil {
		return
	}
	finished := nowISO()
	w.snapshot.CurrentStep = nil
	w.snapshot.Status = status
	w.snapshot.FinishedAt = finished
	w.snapshot.HeartbeatAt = finished
	if opts.Returns != nil {
		w.snapshot.Returns = opts.Returns
	}
	if opts.Error != "" {
		applyFailureExplanation(w.snapshot, opts.Error)
	}
	w.persistUnlocked()
	_ = retentionCleanup(w.getenv)
}

func (w *Writer) mutateLive(patch func(*Snapshot)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.available || w.snapshot == nil || w.snapshot.Status != "" {
		return
	}
	patch(w.snapshot)
	w.snapshot.HeartbeatAt = nowISO()
	w.persistUnlocked()
}

func (w *Writer) persistUnlocked() {
	if !w.available || w.snapshot == nil {
		return
	}
	_ = persistRun(*w.snapshot, w.getenv)
}

func applyFailureExplanation(snap *Snapshot, text string) {
	text = boundFailureExplanation(text)
	for _, step := range snap.Steps {
		if step.Explanation != "" {
			return
		}
	}
	if len(snap.Steps) > 0 {
		last := snap.Steps[len(snap.Steps)-1]
		last.Explanation = text
		snap.Steps[len(snap.Steps)-1] = last
		return
	}
	snap.FailureExplanation = text
}

const failureExplanationLimit = 500

func boundFailureExplanation(text string) string {
	if len(text) <= failureExplanationLimit {
		return text
	}
	return "…" + text[len(text)-failureExplanationLimit:]
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func (w *Writer) startHeartbeatLocked() {
	w.stopHeartbeatLocked()
	stop := make(chan struct{})
	w.hbStop = stop
	tick := time.NewTicker(5 * time.Second)
	go func() {
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				w.Touch()
			case <-stop:
				return
			}
		}
	}()
}

func (w *Writer) stopHeartbeatLocked() {
	if w.hbStop != nil {
		close(w.hbStop)
		w.hbStop = nil
	}
}

func historyACLOpts() *credentials.Options {
	return &credentials.Options{
		Chmod:    chmodIfPrivateOrNew,
		StripACL: func(string) {},
	}
}

func chmodIfPrivateOrNew(path string, mode os.FileMode) error {
	info, err := os.Stat(path)
	if err != nil {
		return os.Chmod(path, mode)
	}
	if info.Mode()&0o077 == 0 {
		return os.Chmod(path, mode)
	}
	if mode != 0o700 || !info.IsDir() {
		return nil
	}
	entries, readErr := os.ReadDir(path)
	if readErr != nil || len(entries) != 0 {
		return nil
	}
	return os.Chmod(path, mode)
}
