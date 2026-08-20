package workbench

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

const (
	lockAttemptsDefault = 50
	lockWaitDefault     = 100 * time.Millisecond
	staleLockDefault    = 10 * time.Second
	probeTimeoutDefault = 2 * time.Second
)

// EndpointRecord names one published workbench endpoint.
type EndpointRecord struct {
	RepoRoot string `json:"repoRoot"`
	URL      string `json:"url"`
	Build    string `json:"build,omitempty"`
}

// WorkbenchHandle is an adopted or owned workbench endpoint.
type WorkbenchHandle struct {
	URL   string
	Owned bool
	Stop  func()
}

// HTTPDoer performs HTTP requests. nil uses http.DefaultClient.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// EnsureWorkbenchDeps injects seams for tests and callers.
type EnsureWorkbenchDeps struct {
	Start        func(Options) (*Server, error)
	HTTPClient   HTTPDoer
	Sleep        func(time.Duration)
	StateDir     string
	WriteRecord  func(EndpointRecord, string) error
	Now          func() time.Time
	StaleLock    time.Duration
	LockAttempts int
	LockWait     time.Duration
}

// OpenWorkbenchOptions selects a repository workbench endpoint.
type OpenWorkbenchOptions struct {
	RepoRoot string
	Port     int
	Build    string
}

func endpointKey(repoRoot string) string {
	sum := sha256.Sum256([]byte(repoRoot))
	return hex.EncodeToString(sum[:])
}

func endpointsDir(stateDir string) string {
	return filepath.Join(stateDir, "web-endpoints")
}

// EndpointRecordPath is the on-disk endpoint record for one repository.
func EndpointRecordPath(repoRoot, stateDir string) string {
	return filepath.Join(endpointsDir(stateDir), endpointKey(repoRoot)+".json")
}

// EndpointLockPath is the on-disk lock file for one repository.
func EndpointLockPath(repoRoot, stateDir string) string {
	return filepath.Join(endpointsDir(stateDir), endpointKey(repoRoot)+".lock")
}

func resolveStateDir(deps EnsureWorkbenchDeps) (string, error) {
	if deps.StateDir != "" {
		return deps.StateDir, nil
	}
	return config.PluginStateDir(os.Getenv)
}

func ensurePrivateDir(stateDir string) error {
	if err := credentials.AssertCredentialStoreSafe(stateDir, nil); err != nil {
		return err
	}
	return credentials.AssertCredentialStoreSafe(endpointsDir(stateDir), nil)
}

func writePrivateFile(path, body string) error {
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), time.Now().UnixNano())
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		return err
	}
	if err := credentials.AssertPrivateCredentialFile(tmp, nil); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return credentials.AssertPrivateCredentialFile(path, nil)
}

// ReadEndpointRecord loads the published endpoint for repoRoot, if any.
func ReadEndpointRecord(repoRoot, stateDir string) (*EndpointRecord, error) {
	path := EndpointRecordPath(repoRoot, stateDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, nil
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, nil
	}
	var root, recordURL, build string
	if err := json.Unmarshal(parsed["repoRoot"], &root); err != nil || root == "" {
		return nil, nil
	}
	if err := json.Unmarshal(parsed["url"], &recordURL); err != nil || recordURL == "" {
		return nil, nil
	}
	if rawBuild, ok := parsed["build"]; ok {
		_ = json.Unmarshal(rawBuild, &build)
		if build == "" {
			build = ""
		}
	}
	rec := &EndpointRecord{RepoRoot: root, URL: recordURL}
	if build != "" {
		rec.Build = build
	}
	return rec, nil
}

// WriteEndpointRecord publishes an endpoint record for repoRoot.
func WriteEndpointRecord(record EndpointRecord, stateDir string) error {
	if err := ensurePrivateDir(stateDir); err != nil {
		return err
	}
	body, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return writePrivateFile(EndpointRecordPath(record.RepoRoot, stateDir), string(body))
}

func removeEndpointRecordIfURL(repoRoot, stateDir, recordURL string) {
	path := EndpointRecordPath(repoRoot, stateDir)
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var parsed struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.URL != recordURL {
		return
	}
	_ = os.Remove(path)
}

// ProbeEndpoint checks whether url serves expectedRepoRoot.
func ProbeEndpoint(recordURL, expectedRepoRoot string, client HTTPDoer) bool {
	if client == nil {
		client = http.DefaultClient
	}
	parsed, err := url.Parse(recordURL)
	if err != nil {
		return false
	}
	token := parsed.Query().Get("token")
	if token == "" {
		return false
	}
	stateURL := parsed.Scheme + "://" + parsed.Host + "/api/state"
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeoutDefault)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, stateURL, nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Hwf-Token", token)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return false
	}
	var data struct {
		CanonicalRepoRoot string `json:"canonicalRepoRoot"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return false
	}
	return data.CanonicalRepoRoot == expectedRepoRoot
}

func probeLiveRecord(repoRoot, stateDir string, client HTTPDoer, build string) (*EndpointRecord, error) {
	record, err := ReadEndpointRecord(repoRoot, stateDir)
	if err != nil || record == nil {
		return nil, err
	}
	if record.RepoRoot != repoRoot {
		return nil, nil
	}
	if record.Build != build {
		return nil, nil
	}
	if !ProbeEndpoint(record.URL, repoRoot, client) {
		return nil, nil
	}
	return record, nil
}

func discardUnusableRecord(repoRoot, stateDir string, client HTTPDoer) error {
	record, err := ReadEndpointRecord(repoRoot, stateDir)
	if err != nil || record == nil {
		return err
	}
	if record.RepoRoot != repoRoot {
		return os.Remove(EndpointRecordPath(repoRoot, stateDir))
	}
	if ProbeEndpoint(record.URL, repoRoot, client) {
		return nil
	}
	removeEndpointRecordIfURL(repoRoot, stateDir, record.URL)
	return nil
}

func servesPort(recordURL string, port int) bool {
	if port == 0 {
		return true
	}
	parsed, err := url.Parse(recordURL)
	if err != nil {
		return false
	}
	return parsed.Port() == fmt.Sprintf("%d", port)
}

func clearOwnedRecordUnderLock(repoRoot, stateDir, recordURL string, now time.Time, staleLock time.Duration) {
	hold := AcquireEndpointLockSync(EndpointLockPath(repoRoot, stateDir), now, staleLock, nil)
	if hold == nil {
		return
	}
	defer ReleaseEndpointLockSync(hold)
	removeEndpointRecordIfURL(repoRoot, stateDir, recordURL)
}

// OpenWorkbench adopts a live endpoint or starts one for repoRoot.
func OpenWorkbench(opts OpenWorkbenchOptions, deps EnsureWorkbenchDeps) (*WorkbenchHandle, error) {
	repoRoot := history.CanonicalRepoRoot(opts.RepoRoot)
	stateDir, err := resolveStateDir(deps)
	if err != nil {
		return nil, err
	}
	client := deps.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	sleep := deps.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	start := deps.Start
	if start == nil {
		start = StartWebServer
	}
	writeRecord := deps.WriteRecord
	if writeRecord == nil {
		writeRecord = WriteEndpointRecord
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	staleLock := deps.StaleLock
	if staleLock <= 0 {
		staleLock = staleLockDefault
	}
	lockAttempts := deps.LockAttempts
	if lockAttempts <= 0 {
		lockAttempts = lockAttemptsDefault
	}
	lockWait := deps.LockWait
	if lockWait <= 0 {
		lockWait = lockWaitDefault
	}
	lockBase := EndpointLockPath(repoRoot, stateDir)

	if err := ensurePrivateDir(stateDir); err != nil {
		return nil, err
	}

	for attempt := 0; attempt < lockAttempts; attempt++ {
		existing, err := probeLiveRecord(repoRoot, stateDir, client, opts.Build)
		if err != nil {
			return nil, err
		}
		if existing != nil && servesPort(existing.URL, opts.Port) {
			return &WorkbenchHandle{URL: existing.URL, Owned: false, Stop: func() {}}, nil
		}

		hold := AcquireEndpointLockSync(lockBase, now(), staleLock, nil)
		if hold == nil {
			sleep(lockWait)
			continue
		}

		again, err := probeLiveRecord(repoRoot, stateDir, client, opts.Build)
		if err != nil {
			ReleaseEndpointLockSync(hold)
			return nil, err
		}
		if again != nil && servesPort(again.URL, opts.Port) {
			ReleaseEndpointLockSync(hold)
			return &WorkbenchHandle{URL: again.URL, Owned: false, Stop: func() {}}, nil
		}

		if again == nil {
			if err := discardUnusableRecord(repoRoot, stateDir, client); err != nil {
				ReleaseEndpointLockSync(hold)
				return nil, err
			}
		}

		server, err := start(Options{RepoRoot: repoRoot, Port: opts.Port})
		if err != nil {
			ReleaseEndpointLockSync(hold)
			return nil, err
		}

		record := EndpointRecord{RepoRoot: repoRoot, URL: server.URL}
		if opts.Build != "" {
			record.Build = opts.Build
		}
		if err := writeRecord(record, stateDir); err != nil {
			server.Stop()
			ReleaseEndpointLockSync(hold)
			return nil, err
		}

		stopped := false
		ownedURL := server.URL
		stop := func() {
			if stopped {
				return
			}
			stopped = true
			server.Stop()
			clearOwnedRecordUnderLock(repoRoot, stateDir, ownedURL, now(), staleLock)
		}
		handle := &WorkbenchHandle{URL: server.URL, Owned: true, Stop: stop}
		ReleaseEndpointLockSync(hold)
		return handle, nil
	}

	return nil, errors.New("timed out waiting for repository workbench endpoint")
}

// EndpointLockHold tracks one endpoint lock claim.
type EndpointLockHold struct {
	Base  string
	Token string
}

// BeforeStealInfo describes a stale lock about to be reclaimed.
type BeforeStealInfo struct {
	Kind  string
	Token string
}

// AcquireLockHooks optional hooks for lock acquisition tests.
type AcquireLockHooks struct {
	BeforeSteal func(BeforeStealInfo)
}

func epOwnedLockPath(base, token string) string {
	return base + "." + token
}

func epIsStale(mod time.Time, now time.Time, staleLock time.Duration) bool {
	return now.Sub(mod) >= staleLock
}

func epClearClaimIfToken(base, expectedToken string) {
	trash := base + ".reclaim." + epRandomToken()
	if err := os.Rename(base, trash); err != nil {
		return
	}
	data, err := os.ReadFile(trash)
	if err != nil || strings.TrimSpace(string(data)) != expectedToken {
		_ = os.Rename(trash, base)
		if err != nil {
			_ = os.Remove(trash)
		}
		return
	}
	_ = os.Remove(trash)
}

func epExistsClaim(base string) bool {
	_, err := os.Stat(base)
	return err == nil
}

func epReclaimStaleClaimSync(base string, now time.Time, staleLock time.Duration, hooks *AcquireLockHooks) bool {
	st, err := os.Stat(base)
	if err != nil {
		return false
	}
	if st.IsDir() {
		return epReclaimLegacyDir(base, st, now, staleLock, hooks)
	}
	return epReclaimOwnedFile(base, now, staleLock, hooks)
}

func epReclaimLegacyDir(base string, st os.FileInfo, now time.Time, staleLock time.Duration, hooks *AcquireLockHooks) bool {
	if !epIsStale(st.ModTime(), now, staleLock) {
		return false
	}
	if hooks != nil && hooks.BeforeSteal != nil {
		hooks.BeforeSteal(BeforeStealInfo{Kind: "legacy"})
	}
	trash := base + ".reclaim." + epRandomToken()
	if err := os.Rename(base, trash); err != nil {
		return false
	}
	trashSt, err := os.Stat(trash)
	if err != nil || !epIsStale(trashSt.ModTime(), now, staleLock) {
		if renameErr := os.Rename(trash, base); renameErr != nil {
			_ = os.RemoveAll(trash)
		}
		return false
	}
	_ = os.RemoveAll(trash)
	return true
}

func epReclaimOwnedFile(base string, now time.Time, staleLock time.Duration, hooks *AcquireLockHooks) bool {
	oldTokenBytes, err := os.ReadFile(base)
	if err != nil {
		return false
	}
	oldToken := strings.TrimSpace(string(oldTokenBytes))
	if oldToken == "" {
		return false
	}

	owned := epOwnedLockPath(base, oldToken)
	ownedSt, err := os.Stat(owned)
	if err != nil {
		if !os.IsNotExist(err) {
			return false
		}
		if hooks != nil && hooks.BeforeSteal != nil {
			hooks.BeforeSteal(BeforeStealInfo{Kind: "dangling", Token: oldToken})
		}
		epClearClaimIfToken(base, oldToken)
		return !epExistsClaim(base)
	}

	if !epIsStale(ownedSt.ModTime(), now, staleLock) {
		return false
	}

	if hooks != nil && hooks.BeforeSteal != nil {
		hooks.BeforeSteal(BeforeStealInfo{Kind: "owned", Token: oldToken})
	}
	trashOwned := owned + ".reclaim." + epRandomToken()
	if err := os.Rename(owned, trashOwned); err != nil {
		return false
	}
	trashOwnedSt, err := os.Stat(trashOwned)
	if err != nil || !epIsStale(trashOwnedSt.ModTime(), now, staleLock) {
		_ = os.Rename(trashOwned, owned)
		if err != nil {
			_ = os.RemoveAll(trashOwned)
		}
		return false
	}

	epClearClaimIfToken(base, oldToken)
	_ = os.RemoveAll(trashOwned)
	return true
}

// AcquireEndpointLockSync claims the endpoint lock at base.
func AcquireEndpointLockSync(base string, now time.Time, staleLock time.Duration, hooks *AcquireLockHooks) *EndpointLockHold {
	if staleLock <= 0 {
		staleLock = staleLockDefault
	}
	token := epRandomToken()
	mine := epOwnedLockPath(base, token)
	if err := os.Mkdir(mine, 0o700); err != nil {
		return nil
	}

	tryClaim := func() (bool, error) {
		f, err := os.OpenFile(base, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				return false, nil
			}
			_ = os.Remove(base)
			return false, err
		}
		defer func() { _ = f.Close() }()
		if _, err := io.WriteString(f, token); err != nil {
			_ = os.Remove(base)
			return false, err
		}
		if err := credentials.AssertPrivateCredentialFile(base, nil); err != nil {
			_ = os.Remove(base)
			return false, err
		}
		return true, nil
	}

	claim, err := tryClaim()
	if err != nil {
		_ = os.RemoveAll(mine)
		return nil
	}
	if claim {
		return &EndpointLockHold{Base: base, Token: token}
	}
	epReclaimStaleClaimSync(base, now, staleLock, hooks)
	claim, err = tryClaim()
	if err != nil {
		_ = os.RemoveAll(mine)
		return nil
	}
	if claim {
		return &EndpointLockHold{Base: base, Token: token}
	}
	_ = os.RemoveAll(mine)
	return nil
}

// ReleaseEndpointLockSync releases one endpoint lock hold.
func ReleaseEndpointLockSync(hold *EndpointLockHold) {
	if hold == nil {
		return
	}
	_ = os.RemoveAll(epOwnedLockPath(hold.Base, hold.Token))
}

func epRandomToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
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
