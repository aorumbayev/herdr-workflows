package workbench

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/history"
)

type stateProbeClient struct {
	mu    sync.Mutex
	roots map[string]string
}

func newStateProbeClient() *stateProbeClient {
	return &stateProbeClient{roots: map[string]string{}}
}

func (c *stateProbeClient) register(s *Server) {
	u, err := url.Parse(s.URL)
	if err != nil {
		panic(err)
	}
	c.mu.Lock()
	c.roots[u.Host] = history.CanonicalRepoRoot(s.repoRoot)
	c.mu.Unlock()
}

func (c *stateProbeClient) Do(req *http.Request) (*http.Response, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusNotImplemented || !strings.HasSuffix(req.URL.Path, "/api/state") {
		return resp, nil
	}
	_ = resp.Body.Close()
	c.mu.Lock()
	root := c.roots[req.URL.Host]
	c.mu.Unlock()
	if root == "" {
		return resp, nil
	}
	body := fmt.Sprintf(`{"canonicalRepoRoot":%q}`, root)
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    req,
	}, nil
}

func tempState(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func canonicalTestRepo(t *testing.T) string {
	t.Helper()
	return history.CanonicalRepoRoot(testRepo(t))
}

func startTrackedServer(t *testing.T, client *stateProbeClient, opts Options) *Server {
	t.Helper()
	s, err := StartWebServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	client.register(s)
	t.Cleanup(s.Stop)
	return s
}

type probeDoerFunc func(*http.Request) (*http.Response, error)

func (f probeDoerFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestProbeEndpointBoundsStateRequest(t *testing.T) {
	before := http.DefaultClient.Timeout
	var got *http.Request
	client := probeDoerFunc(func(req *http.Request) (*http.Response, error) {
		got = req
		return nil, errors.New("stop")
	})
	if ProbeEndpoint("http://127.0.0.1:9/?token=dead", "/tmp/repo", client) {
		t.Fatal("error must be not-live")
	}
	if got == nil {
		t.Fatal("missing request")
	}
	deadline, ok := got.Context().Deadline()
	if !ok {
		t.Fatal("request has no deadline")
	}
	remain := time.Until(deadline)
	if remain < time.Second || remain > probeTimeoutDefault {
		t.Fatalf("remaining deadline %v, want ~%v", remain, probeTimeoutDefault)
	}
	if http.DefaultClient.Timeout != before {
		t.Fatalf("DefaultClient.Timeout changed: %v -> %v", before, http.DefaultClient.Timeout)
	}
}

func TestProbeEndpointTreatsTimeoutAsNotLive(t *testing.T) {
	client := probeDoerFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	start := time.Now()
	if ProbeEndpoint("http://127.0.0.1:9/?token=dead", "/tmp/repo", client) {
		t.Fatal("timeout must be not-live")
	}
	elapsed := time.Since(start)
	if elapsed < probeTimeoutDefault-50*time.Millisecond || elapsed > probeTimeoutDefault+time.Second {
		t.Fatalf("elapsed %v, want ~%v", elapsed, probeTimeoutDefault)
	}
}

func TestEndpointRecordPrivateAndProbe(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	s := startTrackedServer(t, client, Options{RepoRoot: root})

	if err := WriteEndpointRecord(EndpointRecord{RepoRoot: root, URL: s.URL}, stateDir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(EndpointRecordPath(root, stateDir))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode() & 0o777; mode != 0o600 {
		t.Fatalf("mode = %o, want 0600", mode)
	}
	if !ProbeEndpoint(s.URL, root, client) {
		t.Fatal("expected live probe")
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	want := &EndpointRecord{RepoRoot: root, URL: s.URL}
	if got == nil || *got != *want {
		t.Fatalf("record = %#v, want %#v", got, want)
	}
}

func TestStaleOrMismatchedRecordsNotReused(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	if err := WriteEndpointRecord(EndpointRecord{RepoRoot: root, URL: "http://127.0.0.1:1/?token=dead"}, stateDir); err != nil {
		t.Fatal(err)
	}
	if ProbeEndpoint("http://127.0.0.1:1/?token=dead", root, client) {
		t.Fatal("dead endpoint should not probe")
	}

	starts := 0
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			starts++
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	first, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(first.Stop)
	if !first.Owned || starts != 1 {
		t.Fatalf("owned=%v starts=%d", first.Owned, starts)
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || got.URL != first.URL {
		t.Fatalf("record = %#v", got)
	}

	other := canonicalTestRepo(t)
	if err := WriteEndpointRecord(EndpointRecord{RepoRoot: root, URL: first.URL}, stateDir); err != nil {
		t.Fatal(err)
	}
	if ProbeEndpoint(first.URL, other, client) {
		t.Fatal("mismatched repo must not probe")
	}
}

func TestLiveMatchingEndpointReused(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	starts := 0
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			starts++
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owned.Stop)
	if !owned.Owned || starts != 1 {
		t.Fatalf("owned=%v starts=%d", owned.Owned, starts)
	}
	reused, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if reused.Owned || reused.URL != owned.URL || starts != 1 {
		t.Fatalf("reused owned=%v url=%q starts=%d", reused.Owned, reused.URL, starts)
	}
}

func TestLiveWorkbenchBuildIdentityNotAdopted(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	starts := 0
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			starts++
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Build: "ino:1:10"}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owned.Stop)
	if starts != 1 {
		t.Fatalf("starts=%d", starts)
	}
	sameBuild, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Build: "ino:1:10"}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if sameBuild.Owned || sameBuild.URL != owned.URL || starts != 1 {
		t.Fatalf("same build reuse failed owned=%v starts=%d", sameBuild.Owned, starts)
	}
	upgraded, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Build: "ino:2:11"}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(upgraded.Stop)
	if !upgraded.Owned || upgraded.URL == owned.URL || starts != 2 {
		t.Fatalf("upgrade owned=%v starts=%d", upgraded.Owned, starts)
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || got.Build != "ino:2:11" {
		t.Fatalf("record build = %#v", got)
	}
}

func TestLegacyRecordNotAdoptedByIdentifiedBuild(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	starts := 0
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			starts++
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	legacy, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(legacy.Stop)
	rec, err := ReadEndpointRecord(root, stateDir)
	if err != nil || rec == nil || rec.Build != "" {
		t.Fatalf("legacy record = %#v", rec)
	}
	identified, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Build: "ino:3:12"}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(identified.Stop)
	if !identified.Owned || starts != 2 {
		t.Fatalf("identified owned=%v starts=%d", identified.Owned, starts)
	}
}

func TestExplicitPortHonored(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	requested := []int{}
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			requested = append(requested, opts.Port)
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owned.Stop)
	ownedPort, err := portOf(owned.URL)
	if err != nil {
		t.Fatal(err)
	}
	samePort, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Port: ownedPort}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if samePort.Owned || samePort.URL != owned.URL || len(requested) != 1 || requested[0] != 0 {
		t.Fatalf("same port reuse failed requested=%v", requested)
	}
	probe, err := StartWebServer(Options{RepoRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	freePort, err := portOf(probe.URL)
	probe.Stop()
	if err != nil {
		t.Fatal(err)
	}
	other, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root, Port: freePort}, deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(other.Stop)
	otherPort, err := portOf(other.URL)
	if err != nil {
		t.Fatal(err)
	}
	if !other.Owned || otherPort != freePort || requested[0] != 0 || requested[1] != freePort {
		t.Fatalf("other owned=%v port=%d requested=%v", other.Owned, otherPort, requested)
	}
}

func portOf(raw string) (int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return 0, err
	}
	p := u.Port()
	if p == "" {
		return defaultPort, nil
	}
	var n int
	_, err = fmt.Sscanf(p, "%d", &n)
	return n, err
}

func TestStopClearsOwnedEndpointRecord(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rec, _ := ReadEndpointRecord(root, stateDir); rec == nil {
		t.Fatal("expected record before stop")
	}
	owned.Stop()
	if rec, _ := ReadEndpointRecord(root, stateDir); rec != nil {
		t.Fatal("expected record cleared after stop")
	}
}

func TestStopDoesNotRemoveSuccessorRecord(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	replacement := EndpointRecord{
		RepoRoot: root,
		URL:      "http://127.0.0.1:65530/?token=replacement-token",
	}
	if err := WriteEndpointRecord(replacement, stateDir); err != nil {
		t.Fatal(err)
	}
	owned.Stop()
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || *got != replacement {
		t.Fatalf("record = %#v, want %#v", got, replacement)
	}
}

func TestOldOwnerCleanupSkipsUnderSuccessorLock(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	gate := AcquireEndpointLockSync(EndpointLockPath(root, stateDir), time.Now(), staleLockDefault, nil)
	if gate == nil {
		t.Fatal("expected lock")
	}
	successor := EndpointRecord{
		RepoRoot: root,
		URL:      "http://127.0.0.1:65528/?token=successor-under-lock",
	}
	if err := WriteEndpointRecord(successor, stateDir); err != nil {
		t.Fatal(err)
	}
	owned.Stop()
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || *got != successor {
		t.Fatalf("record = %#v", got)
	}
	ReleaseEndpointLockSync(gate)
}

func TestOptimisticLiveCheckPreservesPublishedRecord(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	live := startTrackedServer(t, client, Options{RepoRoot: root})
	if err := WriteEndpointRecord(EndpointRecord{RepoRoot: root, URL: "http://127.0.0.1:1/?token=dead"}, stateDir); err != nil {
		t.Fatal(err)
	}
	deps := EnsureWorkbenchDeps{
		StateDir: stateDir,
		HTTPClient: &optimisticProbeClient{
			inner:    client,
			stateDir: stateDir,
			root:     root,
			liveURL:  live.URL,
		},
		Start: func(Options) (*Server, error) {
			t.Fatal("should reuse the live record published during probe")
			return nil, nil
		},
	}
	result, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if result.Owned || result.URL != live.URL {
		t.Fatalf("result owned=%v url=%q", result.Owned, result.URL)
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || got.URL != live.URL {
		t.Fatalf("record = %#v", got)
	}
}

type optimisticProbeClient struct {
	inner    HTTPDoer
	stateDir string
	root     string
	liveURL  string
}

func (c *optimisticProbeClient) Do(req *http.Request) (*http.Response, error) {
	if strings.Contains(req.URL.String(), "127.0.0.1:1") {
		if err := WriteEndpointRecord(EndpointRecord{RepoRoot: c.root, URL: c.liveURL}, c.stateDir); err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusForbidden, Body: io.NopCloser(strings.NewReader(""))}, nil
	}
	return c.inner.Do(req)
}

func TestTwoStaleReclaimersOnlyOneOwner(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	base := EndpointLockPath(root, stateDir)
	stale := AcquireEndpointLockSync(base, time.Now(), staleLockDefault, nil)
	if stale == nil {
		t.Fatal("expected stale hold")
	}
	past := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(epOwnedLockPath(base, stale.Token), past, past)

	runReclaimer := func() string {
		ch := make(chan string, 1)
		go func() {
			hold := AcquireEndpointLockSync(base, time.Now(), 10*time.Second, nil)
			if hold == nil {
				ch <- "NONE"
				return
			}
			ch <- "HOLD:" + hold.Token
			time.Sleep(150 * time.Millisecond)
			ReleaseEndpointLockSync(hold)
		}()
		return <-ch
	}
	a, b := runReclaimer(), runReclaimer()
	holds := 0
	none := 0
	for _, line := range []string{a, b} {
		if strings.HasPrefix(line, "HOLD:") {
			holds++
		}
		if line == "NONE" {
			none++
		}
	}
	if holds != 1 || none != 1 {
		t.Fatalf("holds=%d none=%d lines=%q %q", holds, none, a, b)
	}
}

func TestStaleReclaimLoserCannotDeleteSuccessorClaim(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	base := EndpointLockPath(root, stateDir)
	stale := AcquireEndpointLockSync(base, time.Now(), staleLockDefault, nil)
	if stale == nil {
		t.Fatal("expected stale hold")
	}
	past := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(epOwnedLockPath(base, stale.Token), past, past)

	ready := make(chan struct{})
	release := make(chan struct{})
	blocked := make(chan string, 1)
	go func() {
		hold := AcquireEndpointLockSync(base, time.Now(), 10*time.Second, &AcquireLockHooks{
			BeforeSteal: func(BeforeStealInfo) {
				close(ready)
				<-release
			},
		})
		if hold == nil {
			blocked <- "NONE"
			return
		}
		blocked <- "HOLD:" + hold.Token
		ReleaseEndpointLockSync(hold)
	}()
	<-ready
	winner := AcquireEndpointLockSync(base, time.Now(), 10*time.Second, nil)
	if winner == nil {
		t.Fatal("expected winner")
	}
	tokenBytes, err := os.ReadFile(base)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(tokenBytes)) != winner.Token {
		t.Fatalf("claim token = %q, want %q", tokenBytes, winner.Token)
	}
	close(release)
	if out := <-blocked; out != "NONE" {
		t.Fatalf("blocked = %q, want NONE", out)
	}
	if tokenBytes, err = os.ReadFile(base); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(tokenBytes)) != winner.Token {
		t.Fatal("successor claim was cleared")
	}
	if _, err := os.Stat(epOwnedLockPath(base, winner.Token)); err != nil {
		t.Fatal("successor owned dir missing")
	}
	ReleaseEndpointLockSync(winner)
}

func TestOldOwnerLockReleaseDoesNotDeleteSuccessorLock(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	base := EndpointLockPath(root, stateDir)
	oldHold := AcquireEndpointLockSync(base, time.Now(), staleLockDefault, nil)
	if oldHold == nil {
		t.Fatal("expected old hold")
	}
	past := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(epOwnedLockPath(base, oldHold.Token), past, past)

	successor := AcquireEndpointLockSync(base, time.Now(), 10*time.Second, nil)
	if successor == nil || successor.Token == oldHold.Token {
		t.Fatalf("successor = %#v", successor)
	}
	ReleaseEndpointLockSync(oldHold)
	tokenBytes, err := os.ReadFile(base)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(tokenBytes)) != successor.Token {
		t.Fatal("successor claim removed")
	}
	if _, err := os.Stat(epOwnedLockPath(base, successor.Token)); err != nil {
		t.Fatal("successor owned dir missing")
	}
	ReleaseEndpointLockSync(successor)
}

func TestPublicationFailureStopsStartedServer(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	var orphan *Server
	_, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			orphan = s
			return s, nil
		},
		WriteRecord: func(EndpointRecord, string) error {
			return fmt.Errorf("disk full")
		},
	})
	if err == nil || err.Error() != "disk full" {
		t.Fatalf("err = %v", err)
	}
	if orphan == nil {
		t.Fatal("expected started server")
	}
	req, err := http.NewRequest(http.MethodGet, orphan.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("expected started server to be stopped after publication failure")
	}
	rec, _ := ReadEndpointRecord(root, stateDir)
	if rec != nil {
		t.Fatal("record should be absent")
	}
}

func TestConcurrentEnsureStartsOneServer(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	starts := 0
	var startMu sync.Mutex
	deps := EnsureWorkbenchDeps{
		StateDir:   stateDir,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			startMu.Lock()
			starts++
			startMu.Unlock()
			time.Sleep(30 * time.Millisecond)
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	}
	var one, two *WorkbenchHandle
	var err1, err2 error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		one, err1 = OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	}()
	go func() {
		defer wg.Done()
		two, err2 = OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, deps)
	}()
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("errors: %v %v", err1, err2)
	}
	t.Cleanup(one.Stop)
	t.Cleanup(two.Stop)
	if starts != 1 || one.URL != two.URL {
		t.Fatalf("starts=%d urls=%q %q", starts, one.URL, two.URL)
	}
	owned := 0
	if one.Owned {
		owned++
	}
	if two.Owned {
		owned++
	}
	if owned != 1 {
		t.Fatalf("owned count = %d", owned)
	}
}

func TestStaleLockReclaimedForLaterLaunch(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	base := EndpointLockPath(root, stateDir)
	stale := AcquireEndpointLockSync(base, time.Now(), staleLockDefault, nil)
	if stale == nil {
		t.Fatal("expected stale hold")
	}
	past := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(epOwnedLockPath(base, stale.Token), past, past)

	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		StaleLock:  10 * time.Second,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owned.Stop)
	if !owned.Owned {
		t.Fatal("expected owned launch")
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got == nil || got.URL != owned.URL {
		t.Fatalf("record = %#v", got)
	}
}

func TestLegacyDirectoryLockReclaimedWhenStale(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	client := newStateProbeClient()
	lock := EndpointLockPath(root, stateDir)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(lock, 0o700); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-60 * time.Second)
	_ = os.Chtimes(lock, past, past)

	owned, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:   stateDir,
		StaleLock:  10 * time.Second,
		HTTPClient: client,
		Start: func(opts Options) (*Server, error) {
			s, err := StartWebServer(opts)
			if err != nil {
				return nil, err
			}
			client.register(s)
			return s, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owned.Stop)
	if !owned.Owned {
		t.Fatal("expected owned launch")
	}
}

func TestFreshLockNotReclaimedBeforeAgeOut(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o700); err != nil {
		t.Fatal(err)
	}
	hold := AcquireEndpointLockSync(EndpointLockPath(root, stateDir), time.Now(), staleLockDefault, nil)
	if hold == nil {
		t.Fatal("expected lock")
	}
	_, err := OpenWorkbench(OpenWorkbenchOptions{RepoRoot: root}, EnsureWorkbenchDeps{
		StateDir:     stateDir,
		LockAttempts: 3,
		LockWait:     5 * time.Millisecond,
		StaleLock:    60 * time.Second,
		Sleep:        func(time.Duration) {},
		Start: func(Options) (*Server, error) {
			t.Fatal("should not start while fresh lock is held")
			return nil, nil
		},
	})
	if err == nil || err.Error() != "timed out waiting for repository workbench endpoint" {
		t.Fatalf("err = %v", err)
	}
	ReleaseEndpointLockSync(hold)
}

func TestMalformedRecordFilesIgnored(t *testing.T) {
	stateDir := tempState(t)
	root := canonicalTestRepo(t)
	if err := os.MkdirAll(filepath.Join(stateDir, "web-endpoints"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(EndpointRecordPath(root, stateDir), []byte("{not-json"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadEndpointRecord(root, stateDir)
	if err != nil || got != nil {
		t.Fatalf("record = %#v err = %v", got, err)
	}
}
