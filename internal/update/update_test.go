package update

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func githubListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[{"plugin_id":"herdr-workflows","source":{"kind":"github","owner":"aorumbayev","repo":"herdr-workflows"}}]}}`
}

func localListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[{"plugin_id":"herdr-workflows","source":{"kind":"local"}}]}}`
}

func emptyListJSON() string {
	return `{"id":"cli:plugin","result":{"type":"plugin_list","plugins":[]}}`
}

func TestParseReleaseTagAndCompare(t *testing.T) {
	got, err := ParseReleaseTag("v0.2.3")
	if err != nil || got.Tag != "v0.2.3" || got.Version != "0.2.3" {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := ParseReleaseTag("0.2.3"); err == nil {
		t.Fatal("bare tag")
	}
	if _, err := ParseReleaseTag("v1.0.0"); err == nil {
		t.Fatal("v1")
	}
	if _, err := ParseReleaseTag("v0.2.3-beta"); err == nil {
		t.Fatal("prerelease")
	}
	if n, _ := CompareSemver("0.1.0", "0.2.0"); n >= 0 {
		t.Fatal("0.1 < 0.2")
	}
	if n, _ := CompareSemver("0.2.0", "0.2.0"); n != 0 {
		t.Fatal("equal")
	}
	if n, _ := CompareSemver("0.3.1", "0.2.9"); n <= 0 {
		t.Fatal("0.3.1 > 0.2.9")
	}
}

func TestCheckForUpdateValidatesJSONAndTimeout(t *testing.T) {
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v0.4.0", "draft": false})
	}))
	defer okSrv.Close()
	got, err := CheckForUpdate(CheckOpts{URL: okSrv.URL, Client: okSrv.Client()})
	if err != nil || got.Version != "0.4.0" {
		t.Fatalf("%+v %v", got, err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("nope"))
	}))
	defer bad.Close()
	_, err = CheckForUpdate(CheckOpts{URL: bad.URL, Client: bad.Client()})
	var checkErr *ReleaseCheckError
	if err == nil || !errors.As(err, &checkErr) || checkErr.Error() != "latest release request failed: HTTP 404" {
		t.Fatalf("404 err %v", err)
	}
	draft := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v0.4.0", "draft": true})
	}))
	defer draft.Close()
	if _, err := CheckForUpdate(CheckOpts{URL: draft.URL, Client: draft.Client()}); err == nil || err.Error() != "latest release endpoint returned a draft" {
		t.Fatalf("draft %v", err)
	}
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer hang.Close()
	if _, err := CheckForUpdate(CheckOpts{URL: hang.URL, Client: hang.Client(), Timeout: 20 * time.Millisecond}); err == nil {
		t.Fatal("expected timeout")
	} else if _, ok := err.(*ReleaseCheckError); !ok {
		t.Fatalf("timeout type %T %v", err, err)
	}
}

func TestParsePluginListSource(t *testing.T) {
	gh, err := ParsePluginListSource(githubListJSON())
	if err != nil || gh.Kind != "github" || gh.Owner != "aorumbayev" || gh.Repo != "herdr-workflows" {
		t.Fatalf("%+v %v", gh, err)
	}
	local, _ := ParsePluginListSource(localListJSON())
	if local.Kind != "local" {
		t.Fatalf("%+v", local)
	}
	empty, _ := ParsePluginListSource(emptyListJSON())
	if empty.Kind != "unregistered" {
		t.Fatalf("%+v", empty)
	}
	other, _ := ParsePluginListSource(`{"result":{"type":"plugin_list","plugins":[{"plugin_id":"other","source":{"kind":"github"}}]}}`)
	if other.Kind != "unregistered" {
		t.Fatalf("%+v", other)
	}
	bare, _ := ParsePluginListSource(`{"plugins":[{"plugin_id":"herdr-workflows"}]}`)
	if bare.Kind != "unregistered" {
		t.Fatalf("%+v", bare)
	}
}

func TestLeavePluginRootOutsideCheckout(t *testing.T) {
	before, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	outside, err := LeavePluginRoot(before, os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	if outside == before {
		t.Fatal("did not leave")
	}
	wd, _ := os.Getwd()
	if wd != before {
		t.Fatalf("process cwd mutated to %s", wd)
	}
}

func TestUpdatePluginOutcomes(t *testing.T) {
	current := "0.1.0"
	newer := "0.999.0"
	up, err := UpdatePlugin(Deps{
		Version:     current,
		FetchLatest: func() (LatestRelease, error) { return LatestRelease{Tag: "v" + current, Version: current}, nil },
	})
	if err != nil || up.Kind != "up_to_date" || up.Current != current {
		t.Fatalf("%+v %v", up, err)
	}
	local, err := UpdatePlugin(Deps{
		Version:     current,
		FetchLatest: func() (LatestRelease, error) { return LatestRelease{Tag: "v" + newer, Version: newer}, nil },
		ListSource:  func() (PluginSourceInfo, error) { src, _ := ParsePluginListSource(localListJSON()); return src, nil },
	})
	if err != nil || local.Kind != "refused_local" {
		t.Fatalf("%+v %v", local, err)
	}
	standaloneDir := t.TempDir()
	standaloneDest := filepath.Join(standaloneDir, "herdr-workflows")
	if err := os.WriteFile(standaloneDest, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	var standaloneCalls int
	unreg, err := UpdatePlugin(Deps{
		Version:     current,
		FetchLatest: func() (LatestRelease, error) { return LatestRelease{Tag: "v" + newer, Version: newer}, nil },
		ListSource:  func() (PluginSourceInfo, error) { src, _ := ParsePluginListSource(emptyListJSON()); return src, nil },
		Executable:  func() (string, error) { return standaloneDest, nil },
		InstallRelease: func(opts InstallOpts) error {
			standaloneCalls++
			if opts.Version != newer || opts.DestPath != standaloneDest {
				t.Fatalf("opts %+v", opts)
			}
			return os.WriteFile(opts.DestPath, []byte("new"), 0o755)
		},
	})
	if err != nil || unreg.Kind != "updated" || unreg.To != newer {
		t.Fatalf("%+v %v", unreg, err)
	}
	if standaloneCalls != 1 {
		t.Fatalf("standaloneCalls = %d", standaloneCalls)
	}
	pluginRoot := t.TempDir()
	var installs []struct {
		args []string
		cwd  string
	}
	fail, err := UpdatePlugin(Deps{
		Version:     current,
		PluginRoot:  pluginRoot,
		FetchLatest: func() (LatestRelease, error) { return LatestRelease{Tag: "v" + newer, Version: newer}, nil },
		ListSource:  func() (PluginSourceInfo, error) { src, _ := ParsePluginListSource(githubListJSON()); return src, nil },
		RunInstall: func(args []string, cwd string) (int, error) {
			installs = append(installs, struct {
				args []string
				cwd  string
			}{args, cwd})
			return 7, nil
		},
		Getenv: os.Getenv,
	})
	if err != nil || fail.Kind != "install_failed" || fail.Code != 7 {
		t.Fatalf("%+v %v", fail, err)
	}
	if len(installs) != 1 || installs[0].cwd == pluginRoot {
		t.Fatalf("installs %+v", installs)
	}
	wantArgs := []string{"plugin", "install", "aorumbayev/herdr-workflows", "--ref", "v" + newer, "--yes"}
	if len(installs[0].args) != len(wantArgs) {
		t.Fatalf("args %v", installs[0].args)
	}
	for i := range wantArgs {
		if installs[0].args[i] != wantArgs[i] {
			t.Fatalf("args %v", installs[0].args)
		}
	}
	ok, err := UpdatePlugin(Deps{
		Version:     current,
		PluginRoot:  pluginRoot,
		FetchLatest: func() (LatestRelease, error) { return LatestRelease{Tag: "v" + newer, Version: newer}, nil },
		ListSource:  func() (PluginSourceInfo, error) { src, _ := ParsePluginListSource(githubListJSON()); return src, nil },
		RunInstall:  func(args []string, cwd string) (int, error) { return 0, nil },
		Getenv:      os.Getenv,
	})
	if err != nil || ok.Kind != "updated" || ok.To != newer {
		t.Fatalf("%+v %v", ok, err)
	}
}
