package workbench

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const staleLockMS = 10_000

type saveResult struct {
	status int
	body   map[string]any
}

func saveOK(body map[string]any) *saveResult {
	if body == nil {
		body = map[string]any{}
	}
	body["ok"] = true
	return &saveResult{status: 200, body: body}
}

func saveErr(status int, msg string, extra ...map[string]any) *saveResult {
	body := map[string]any{"ok": false, "error": msg}
	if len(extra) > 0 {
		for k, v := range extra[0] {
			body[k] = v
		}
	}
	return &saveResult{status: status, body: body}
}

type scopeRef struct {
	name  string
	scope string
}

func contentToken(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:16]
}

func diskToken(file string) (string, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	return contentToken(string(data)), true
}

func existingFileMode(file string) fs.FileMode {
	st, err := os.Lstat(file)
	if err != nil || st.Mode()&os.ModeSymlink != 0 || !st.Mode().IsRegular() {
		return 0o600
	}
	return st.Mode().Perm()
}

func claimFile(file, text, taken string) *saveResult {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return saveErr(500, err.Error())
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return saveErr(409, taken)
		}
		return saveErr(500, err.Error())
	}
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		_ = os.Remove(file)
		return saveErr(500, err.Error())
	}
	if err := f.Close(); err != nil {
		return saveErr(500, err.Error())
	}
	return nil
}

type endpointLockHold struct {
	base  string
	token string
}

func saveOwnedLockPath(base, token string) string {
	return base + "." + token
}

func newLockToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}

func saveIsStale(st fs.FileInfo, now time.Time, staleLockMs int64) bool {
	return now.Sub(st.ModTime()) >= time.Duration(staleLockMs)*time.Millisecond
}

func saveClearClaimIfToken(base, expectedToken string) {
	trash := base + ".reclaim." + newLockToken()
	if err := os.Rename(base, trash); err != nil {
		return
	}
	data, err := os.ReadFile(trash)
	if err == nil && strings.TrimSpace(string(data)) != expectedToken {
		_ = os.Rename(trash, base)
		return
	}
	_ = os.Remove(trash)
}

func saveExistsClaim(base string) bool {
	_, err := os.Stat(base)
	return err == nil
}

func saveReclaimStaleClaimSync(base string, now time.Time, staleLockMs int64) bool {
	st, err := os.Stat(base)
	if err != nil {
		return false
	}
	if st.IsDir() {
		if !saveIsStale(st, now, staleLockMs) {
			return false
		}
		trash := base + ".reclaim." + newLockToken()
		if err := os.Rename(base, trash); err != nil {
			return false
		}
		if stTrash, err := os.Stat(trash); err != nil || !saveIsStale(stTrash, now, staleLockMs) {
			_ = os.Rename(trash, base)
			_ = os.RemoveAll(trash)
			return false
		}
		_ = os.RemoveAll(trash)
		return true
	}
	oldToken, err := os.ReadFile(base)
	if err != nil {
		return false
	}
	token := strings.TrimSpace(string(oldToken))
	if token == "" {
		return false
	}
	owned := saveOwnedLockPath(base, token)
	ownedSt, ownedErr := os.Stat(owned)
	if ownedErr != nil {
		if os.IsNotExist(ownedErr) {
			saveClearClaimIfToken(base, token)
			return !saveExistsClaim(base)
		}
		return false
	}
	if !saveIsStale(ownedSt, now, staleLockMs) {
		return false
	}
	trashOwned := owned + ".reclaim." + newLockToken()
	if err := os.Rename(owned, trashOwned); err != nil {
		return false
	}
	if stTrash, err := os.Stat(trashOwned); err != nil || !saveIsStale(stTrash, now, staleLockMs) {
		_ = os.Rename(trashOwned, owned)
		_ = os.RemoveAll(trashOwned)
		return false
	}
	saveClearClaimIfToken(base, token)
	_ = os.RemoveAll(trashOwned)
	return true
}

func acquireEndpointLockSync(base string, now time.Time, staleLockMs int64) *endpointLockHold {
	token := newLockToken()
	mine := saveOwnedLockPath(base, token)
	_ = os.MkdirAll(mine, 0o700)
	tryClaim := func() (bool, error) {
		f, err := os.OpenFile(base, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				return false, nil
			}
			_ = os.Remove(base)
			return false, err
		}
		if _, err := f.WriteString(token); err != nil {
			_ = f.Close()
			_ = os.Remove(base)
			return false, err
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(base)
			return false, err
		}
		if err := credentials.AssertPrivateCredentialFile(base, nil); err != nil {
			_ = os.Remove(base)
			return false, err
		}
		return true, nil
	}
	if ok, err := tryClaim(); err != nil {
		_ = os.RemoveAll(mine)
		return nil
	} else if ok {
		return &endpointLockHold{base: base, token: token}
	}
	saveReclaimStaleClaimSync(base, now, staleLockMs)
	if ok, err := tryClaim(); err != nil {
		_ = os.RemoveAll(mine)
		return nil
	} else if ok {
		return &endpointLockHold{base: base, token: token}
	}
	_ = os.RemoveAll(mine)
	return nil
}

func releaseEndpointLockSync(hold *endpointLockHold) {
	if hold == nil {
		return
	}
	_ = os.RemoveAll(saveOwnedLockPath(hold.base, hold.token))
}

func replaceInPlace(file, text, base, name, scope, trustedBase string) *saveResult {
	claim := file + ".save"
	hold := acquireEndpointLockSync(claim, time.Now(), staleLockMS)
	if hold == nil {
		return saveErr(409, "'"+name+"' is being saved in "+scope)
	}
	tmp := filepath.Join(filepath.Dir(file), "."+name+"."+newLockToken()+".tmp")
	published := false
	defer func() {
		if !published {
			releaseEndpointLockSync(hold)
		}
	}()
	if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, name); unsafe != nil {
		return unsafe
	}
	onDisk, exists := diskToken(file)
	if !exists {
		onDisk = ""
	}
	if base == "" {
		if exists {
			return saveErr(409, "'"+name+"' changed in "+scope+" since this buffer was loaded — reload to see the current file before saving", map[string]any{"stale": true})
		}
	} else if onDisk != base {
		msg := "'" + name + "' changed in " + scope + " since this buffer was loaded — reload to see the current file before saving"
		if !exists {
			msg = "'" + name + "' no longer exists in " + scope + "; it changed since this buffer was loaded"
		}
		return saveErr(409, msg, map[string]any{"stale": true})
	}
	mode := existingFileMode(file)
	if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
		return saveErr(500, err.Error())
	}
	if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, name); unsafe != nil {
		_ = os.Remove(tmp)
		return unsafe
	}
	if err := os.Rename(tmp, file); err != nil {
		stillThere := !os.IsNotExist(err)
		_ = os.Remove(tmp)
		if _, statErr := os.Lstat(tmp); statErr == nil {
			stillThere = true
		}
		if stillThere {
			return saveErr(500, "save failed — "+err.Error()+"; temporary file left at "+shortPath(tmp), map[string]any{"orphan": shortPath(tmp)})
		}
		return saveErr(500, err.Error())
	}
	published = true
	if err := releaseEndpointLockSyncSafe(hold); err != nil {
		return saveErr(500, fmt.Sprintf("saved '%s' but could not release save claim at %s — %s", name, shortPath(claim), err.Error()), map[string]any{"orphan": shortPath(claim)})
	}
	if _, err := os.Stat(saveOwnedLockPath(claim, hold.token)); err == nil {
		return saveErr(500, fmt.Sprintf("saved '%s' but save claim at %s still blocks later saves", name, shortPath(claim)), map[string]any{"orphan": shortPath(claim)})
	}
	return saveOK(map[string]any{"base": contentToken(text)})
}

func releaseEndpointLockSyncSafe(hold *endpointLockHold) error {
	if hold == nil {
		return nil
	}
	path := saveOwnedLockPath(hold.base, hold.token)
	releaseEndpointLockSync(hold)
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("owned marker still present")
	}
	return nil
}

func writeWorkflow(repoRoot, name, scope, text string, previous *scopeRef, base string) *saveResult {
	if !workflow.NameRE.MatchString(name) {
		return saveErr(400, "invalid workflow name")
	}
	normalized := workflow.WithPinnedSchemaPointer(text)
	cfg, err := config.LoadConfig(repoRoot, os.Getenv)
	if err != nil {
		return saveErr(500, err.Error())
	}
	if _, err := workflow.ParseWorkflowText(name, normalized, cfg, repoRoot, name+".yaml"); err != nil {
		return saveErr(400, err.Error())
	}
	file, err := workflow.WorkflowPath(scope, repoRoot, name)
	if err != nil {
		return saveErr(400, err.Error())
	}
	trustedBase, err := trustedWorkflowBase(scope, repoRoot)
	if err != nil {
		return saveErr(500, err.Error())
	}
	if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, name); unsafe != nil {
		return unsafe
	}
	var prevFile string
	if previous != nil {
		prevFile, err = workflow.WorkflowPath(previous.scope, repoRoot, previous.name)
		if err != nil {
			return saveErr(400, err.Error())
		}
		prevTrusted, err := trustedWorkflowBase(previous.scope, repoRoot)
		if err != nil {
			return saveErr(500, err.Error())
		}
		if unsafe := refuseUnsafeWorkflowPath(prevFile, prevTrusted, previous.name); unsafe != nil {
			return unsafe
		}
	}
	if previous != nil && prevFile == file {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return saveErr(500, err.Error())
		}
		if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, name); unsafe != nil {
			return unsafe
		}
		return replaceInPlace(file, normalized, base, name, scope, trustedBase)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return saveErr(500, err.Error())
	}
	if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, name); unsafe != nil {
		return unsafe
	}
	if claimed := claimFile(file, normalized, "'"+name+"' already exists in "+scope); claimed != nil {
		return claimed
	}
	if previous == nil {
		return saveOK(map[string]any{"base": contentToken(normalized)})
	}
	src, err := workflow.WorkflowPath(previous.scope, repoRoot, previous.name)
	if err != nil {
		_ = os.Remove(file)
		return saveErr(500, err.Error())
	}
	return DropSource(src, file, previous.name)
}

// DropSource removes the source after a successful destination claim.
func DropSource(source, claimed, label string) *saveResult {
	if err := os.Remove(source); err != nil {
		if os.IsNotExist(err) {
			return saveOK(nil)
		}
		kept := "'" + label + "' could not be removed — " + err.Error()
		if rmErr := os.Remove(claimed); rmErr != nil {
			return saveErr(500, kept+"; the copy at "+shortPath(claimed)+" could not be undone — "+rmErr.Error(), map[string]any{"orphan": shortPath(claimed)})
		}
		return saveErr(500, kept)
	}
	return saveOK(nil)
}
