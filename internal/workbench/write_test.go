package workbench

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func oneSuccessOneConflict(codes []int) bool {
	return (codes[0] == 200 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 200)
}

func apiGet(t *testing.T, s *Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, originOf(s.port)+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func apiJSON(t *testing.T, s *Server, method, path string, body any) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, originOf(s.port)+path, r)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func decodeJSON(t *testing.T, res *http.Response, dst any) {
	t.Helper()
	defer func() { _ = res.Body.Close() }()
	if err := json.NewDecoder(res.Body).Decode(dst); err != nil {
		t.Fatal(err)
	}
}

func TestWorkflowGETRejectsPathTraversal(t *testing.T) {
	s := startTestServer(t, testRepo(t))
	res := apiGet(t, s, "/api/workflow?name=..%2F..%2F.hwf%2Fconfig&scope=repo")
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
}

func TestWorkflowGETReportsSensitivityFlags(t *testing.T) {
	root := testRepo(t)
	text := v1 + "steps:\n  - agent: \"x {{context.transcript_file}}\"\n    using: claude\n"
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "t.yaml"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=t&scope=repo")
	var data struct {
		Flags []string `json:"flags"`
		Valid bool     `json:"valid"`
	}
	decodeJSON(t, res, &data)
	if !data.Valid {
		t.Fatal("expected valid workflow")
	}
	found := false
	for _, f := range data.Flags {
		if f == "transcript" {
			found = true
		}
	}
	if !found {
		t.Fatalf("flags = %v, want transcript", data.Flags)
	}
}

func TestFirstSaveCreatesMissingRepoWorkflowDirectory(t *testing.T) {
	root := testRepo(t)
	if err := os.RemoveAll(filepath.Join(root, ".hwf")); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name":  "first",
		"scope": "repo",
		"text":  v1 + "steps:\n  - run: [echo, first]\n",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	data, err := os.ReadFile(filepath.Join(root, ".hwf", "workflows", "first.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "echo, first") {
		t.Fatalf("file = %q", string(data))
	}
}

func TestInvalidSaveRejectedNotWritten(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name":  "bad",
		"scope": "repo",
		"text":  v1 + "steps:\n  - run: true\n    out: x\n",
	})
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, res, &data)
	if data.OK {
		t.Fatal("expected ok=false")
	}
	if !strings.Contains(data.Error, "out") && !strings.Contains(data.Error, "Invalid input") && !strings.Contains(data.Error, "Unrecognized key") {
		t.Fatalf("error = %q", data.Error)
	}
	if _, err := os.Stat(filepath.Join(root, ".hwf", "workflows", "bad.yaml")); !os.IsNotExist(err) {
		t.Fatal("bad.yaml should not exist")
	}
}

func TestValidSaveWrites(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name":  "good",
		"scope": "repo",
		"text":  v1 + "steps:\n  - run: echo hi\n",
	})
	var data struct {
		OK bool `json:"ok"`
	}
	decodeJSON(t, res, &data)
	if !data.OK {
		t.Fatal("expected ok=true")
	}
	if _, err := os.Stat(filepath.Join(root, ".hwf", "workflows", "good.yaml")); err != nil {
		t.Fatal(err)
	}
}

func TestPUTPinsSchemaPointerAndNextSaveWorks(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "edit.yaml")
	body := v1 + "steps:\n  - run: echo hi\n"
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=edit&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	first := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"base": loaded.Base, "text": body,
	})
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first status = %d", first.StatusCode)
	}
	var firstBody struct {
		OK   bool   `json:"ok"`
		Base string `json:"base"`
	}
	decodeJSON(t, first, &firstBody)
	pointer := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL()
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != pointer+"\n"+body {
		t.Fatalf("on disk = %q", string(onDisk))
	}
	secondText := strings.Replace(string(onDisk), "echo hi", "echo again", 1)
	second := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"base": firstBody.Base, "text": secondText,
	})
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second status = %d", second.StatusCode)
	}
	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(after), "echo again") {
		t.Fatalf("file = %q", string(after))
	}
}

func TestPUTReplacesStaleSchemaPointer(t *testing.T) {
	stale := "# yaml-language-server: $schema=https://raw.githubusercontent.com/aorumbayev/herdr-workflows/main/docs/workflow.schema.json"
	cases := []struct {
		name string
		text string
	}{
		{"first", stale + "\n" + v1 + "steps:\n  - run: echo hi\n"},
		{"below", v1 + stale + "\nsteps:\n  - run: echo hi\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := testRepo(t)
			file := filepath.Join(root, ".hwf", "workflows", tc.name+".yaml")
			if err := os.WriteFile(file, []byte(tc.text), 0o600); err != nil {
				t.Fatal(err)
			}
			s := startTestServer(t, root)
			res := apiGet(t, s, "/api/workflow?name="+tc.name+"&scope=repo")
			var loaded struct {
				Base string `json:"base"`
			}
			decodeJSON(t, res, &loaded)
			put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
				"name": tc.name, "scope": "repo", "previousName": tc.name, "previousScope": "repo",
				"base": loaded.Base, "text": tc.text,
			})
			if put.StatusCode != http.StatusOK {
				t.Fatalf("status = %d", put.StatusCode)
			}
			onDisk, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(onDisk), "yaml-language-server:") != 1 {
				t.Fatalf("pointer count in %q", string(onDisk))
			}
			if strings.Contains(string(onDisk), "/main/") {
				t.Fatal("should not contain /main/")
			}
			wantPrefix := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL() + "\n"
			if !strings.HasPrefix(string(onDisk), wantPrefix) {
				t.Fatalf("prefix = %q", string(onDisk))
			}
		})
	}
}

func TestPUTLeavesPinnedPointerByteIdentical(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "edit.yaml")
	body := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL() + "\n" + v1 + "steps:\n  - run: echo hi\n"
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=edit&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"base": loaded.Base, "text": body,
	})
	if put.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", put.StatusCode)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != body {
		t.Fatalf("on disk changed: %q", string(onDisk))
	}
}

func TestSamePathPUTOverwrites(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "edit.yaml")
	if err := os.WriteFile(file, []byte(v1+"steps:\n  - run: echo old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=edit&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"base": loaded.Base, "text": v1 + "steps:\n  - run: echo new\n",
	})
	var data struct {
		OK bool `json:"ok"`
	}
	decodeJSON(t, put, &data)
	if !data.OK {
		t.Fatal("expected ok")
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "echo new") {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestSamePathPUTRefusesStaleBaseline(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "edit.yaml")
	if err := os.WriteFile(file, []byte(v1+"steps:\n  - run: echo original\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=edit&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	if err := os.WriteFile(file, []byte(v1+"steps:\n  - run: echo someone-elses-fix\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"base": loaded.Base, "text": v1 + "steps:\n  - run: echo my-edit\n",
	})
	if put.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", put.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Stale bool   `json:"stale"`
		Error string `json:"error"`
	}
	decodeJSON(t, put, &data)
	if data.OK || !data.Stale || !strings.Contains(data.Error, "changed") {
		t.Fatalf("body = %+v", data)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "someone-elses-fix") {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestSamePathPUTWithoutBaselineRefused(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "edit.yaml")
	if err := os.WriteFile(file, []byte(v1+"steps:\n  - run: echo original\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "edit", "scope": "repo", "previousName": "edit", "previousScope": "repo",
		"text": v1 + "steps:\n  - run: echo blind\n",
	})
	if put.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", put.StatusCode)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "echo original") {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestPUTWithoutPreviousPathRefusesClobber(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "mine.yaml")
	if err := os.WriteFile(file, []byte(v1+"steps:\n  - run: echo mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "mine", "scope": "repo", "text": v1 + "steps:\n  - run: echo theirs\n",
	})
	if put.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", put.StatusCode)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "echo mine") {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestRenamePUTRefusesOccupiedDestination(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	for name, echo := range map[string]string{"src": "src", "taken": "taken"} {
		if err := os.WriteFile(filepath.Join(wdir, name+".yaml"), []byte(v1+"steps:\n  - run: echo "+echo+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "taken", "scope": "repo", "previousName": "src", "previousScope": "repo",
		"text": v1 + "steps:\n  - run: echo moved\n",
	})
	if put.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", put.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, put, &data)
	if data.OK || !strings.Contains(data.Error, "already exists in repo") {
		t.Fatalf("body = %+v", data)
	}
	taken, _ := os.ReadFile(filepath.Join(wdir, "taken.yaml"))
	if !strings.Contains(string(taken), "echo taken") {
		t.Fatal("taken.yaml changed")
	}
	src, _ := os.ReadFile(filepath.Join(wdir, "src.yaml"))
	if !strings.Contains(string(src), "echo src") {
		t.Fatal("src.yaml changed")
	}
}

func TestRenamePUTMovesWorkflow(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	if err := os.WriteFile(filepath.Join(wdir, "old.yaml"), []byte(v1+"steps:\n  - run: echo old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "fresh", "scope": "repo", "previousName": "old", "previousScope": "repo",
		"text": v1 + "steps:\n  - run: echo fresh\n",
	})
	var data struct {
		OK bool `json:"ok"`
	}
	decodeJSON(t, put, &data)
	if !data.OK {
		t.Fatal("expected ok")
	}
	fresh, err := os.ReadFile(filepath.Join(wdir, "fresh.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fresh), "echo fresh") {
		t.Fatalf("fresh = %q", string(fresh))
	}
	if _, err := os.Stat(filepath.Join(wdir, "old.yaml")); !os.IsNotExist(err) {
		t.Fatal("old.yaml should be gone")
	}
}

func TestConcurrentRenamesIntoOneDestination(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	for _, name := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(wdir, name+".yaml"), []byte(v1+"steps:\n  - run: echo "+name+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s := startTestServer(t, root)
	move := func(from string) *http.Response {
		return apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
			"name": "shared", "scope": "repo", "previousName": from, "previousScope": "repo",
			"text": v1 + "steps:\n  - run: echo " + from + "\n",
		})
	}
	var wg sync.WaitGroup
	results := make([]*http.Response, 2)
	for i, from := range []string{"a", "b"} {
		wg.Add(1)
		go func(i int, from string) {
			defer wg.Done()
			results[i] = move(from)
		}(i, from)
	}
	wg.Wait()
	codes := []int{results[0].StatusCode, results[1].StatusCode}
	if !oneSuccessOneConflict(codes) {
		t.Fatalf("codes = %v, want one 200 and one 409", codes)
	}
	dest, err := os.ReadFile(filepath.Join(wdir, "shared.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	winner := "a"
	if strings.Contains(string(dest), "echo b") {
		winner = "b"
	}
	loser := "a"
	if winner == "a" {
		loser = "b"
	}
	if _, err := os.Stat(filepath.Join(wdir, winner+".yaml")); !os.IsNotExist(err) {
		t.Fatalf("%s.yaml should be gone", winner)
	}
	loserData, err := os.ReadFile(filepath.Join(wdir, loser+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(loserData), "echo "+loser) {
		t.Fatalf("loser file = %q", string(loserData))
	}
}

func TestConcurrentInPlaceSavesWithOneBaseline(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "race.yaml")
	body := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL() + "\n" + v1 + "steps:\n  - run: echo base\n"
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=race&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	put := func(marker string) *http.Response {
		return apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
			"name": "race", "scope": "repo", "previousName": "race", "previousScope": "repo",
			"base": loaded.Base, "text": strings.Replace(body, "echo base", "echo "+marker, 1),
		})
	}
	var wg sync.WaitGroup
	results := make([]*http.Response, 2)
	for i, marker := range []string{"one", "two"} {
		wg.Add(1)
		go func(i int, marker string) {
			defer wg.Done()
			results[i] = put(marker)
		}(i, marker)
	}
	wg.Wait()
	codes := []int{results[0].StatusCode, results[1].StatusCode}
	if !oneSuccessOneConflict(codes) {
		t.Fatalf("codes = %v", codes)
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	hasOne := strings.Contains(string(onDisk), "echo one")
	hasTwo := strings.Contains(string(onDisk), "echo two")
	if hasOne == hasTwo {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestSymlinkedWorkflowFileRefused(t *testing.T) {
	root := testRepo(t)
	outside := filepath.Join(root, "outside-target.yaml")
	original := v1 + "steps:\n  - run: echo external\n"
	if err := os.WriteFile(outside, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, ".hwf", "workflows", "linked.yaml")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=linked&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	base := loaded.Base
	if base == "" {
		base = "missing"
	}
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "linked", "scope": "repo", "previousName": "linked", "previousScope": "repo",
		"base": base, "text": v1 + "steps:\n  - run: echo overwritten\n",
	})
	if put.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", put.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, put, &data)
	if data.OK || !strings.Contains(strings.ToLower(data.Error), "symlink") {
		t.Fatalf("body = %+v", data)
	}
	out, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != original {
		t.Fatalf("target changed: %q", string(out))
	}
}

func TestSymlinkedWorkflowRootRefused(t *testing.T) {
	root := testRepo(t)
	outsideDir := filepath.Join(root, "outside-workflows")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(outsideDir, "kept.yaml")
	original := v1 + "steps:\n  - run: echo kept\n"
	if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	wdir := filepath.Join(root, ".hwf", "workflows")
	if err := os.RemoveAll(wdir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, wdir); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "escape", "scope": "repo", "text": v1 + "steps:\n  - run: echo escape\n",
	})
	if put.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", put.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, put, &data)
	if data.OK || !strings.Contains(strings.ToLower(data.Error), "symlink") {
		t.Fatalf("body = %+v", data)
	}
	kept, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(kept) != original {
		t.Fatal("target changed")
	}
	if _, err := os.Stat(filepath.Join(outsideDir, "escape.yaml")); !os.IsNotExist(err) {
		t.Fatal("escape.yaml should not exist")
	}
}

func TestIntermediateHWFSymlinkCannotRedirectWorkflowWrite(t *testing.T) {
	root := testRepo(t)
	outside := filepath.Join(root, "outside-hwf")
	if err := os.MkdirAll(filepath.Join(outside, "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "config.yaml"), []byte("profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	trap := filepath.Join(outside, "workflows", "escape.yaml")
	if err := os.RemoveAll(filepath.Join(root, ".hwf")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, ".hwf")); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "escape", "scope": "repo", "text": v1 + "steps:\n  - run: echo escape\n",
	})
	if put.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", put.StatusCode)
	}
	if _, err := os.Stat(trap); !os.IsNotExist(err) {
		t.Fatal("trap file should not exist")
	}
}

func TestSymlinkedConfigFileRefused(t *testing.T) {
	root := testRepo(t)
	outside := filepath.Join(root, "outside-config")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(outside, "config.yaml")
	original := "profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n"
	if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, ".hwf", "config.yaml")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/config", map[string]any{
		"scope": "repo",
		"text":  "profiles:\n  other:\n    kind: claude\ndefault_profile: other\n",
	})
	if put.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", put.StatusCode)
	}
	out, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != original {
		t.Fatal("target changed")
	}
	st, err := os.Lstat(link)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("link should remain symlink")
	}
}

func TestIntermediateHWFSymlinkCannotRedirectConfigWrite(t *testing.T) {
	root := testRepo(t)
	outside := filepath.Join(root, "outside-hwf")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(outside, "config.yaml")
	original := "profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n"
	if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, ".hwf")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, ".hwf")); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/config", map[string]any{
		"scope": "repo",
		"text":  "profiles:\n  other:\n    kind: claude\ndefault_profile: other\n",
	})
	if put.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", put.StatusCode)
	}
	out, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != original {
		t.Fatal("target changed")
	}
	st, err := os.Lstat(filepath.Join(root, ".hwf"))
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatal(".hwf should remain symlink")
	}
}

func TestStaleSaveClaimReclaimed(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "claim.yaml")
	body := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL() + "\n" + v1 + "steps:\n  - run: echo base\n"
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	claim := file + ".save"
	stale := acquireEndpointLockSync(claim, time.Now(), staleLockMS)
	if stale == nil {
		t.Fatal("expected stale lock")
	}
	past := time.Now().Add(-60 * time.Second)
	if err := os.Chtimes(saveOwnedLockPath(claim, stale.token), past, past); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=claim&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "claim", "scope": "repo", "previousName": "claim", "previousScope": "repo",
		"base": loaded.Base, "text": strings.Replace(body, "echo base", "echo next", 1),
	})
	var data struct {
		OK bool `json:"ok"`
	}
	decodeJSON(t, put, &data)
	if !data.OK {
		t.Fatal("expected ok")
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "echo next") {
		t.Fatalf("file = %q", string(onDisk))
	}
	successor := acquireEndpointLockSync(claim, time.Now(), staleLockMS)
	if successor == nil {
		t.Fatal("expected successor lock")
	}
	if successor.token == stale.token {
		t.Fatal("successor token should differ")
	}
	if _, err := os.Stat(saveOwnedLockPath(claim, successor.token)); err != nil {
		t.Fatal("successor owned marker missing")
	}
	releaseEndpointLockSync(stale)
	claimData, err := os.ReadFile(claim)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(claimData)) != successor.token {
		t.Fatalf("claim = %q, want %q", string(claimData), successor.token)
	}
	if _, err := os.Stat(saveOwnedLockPath(claim, successor.token)); err != nil {
		t.Fatal("successor owned marker should remain")
	}
	releaseEndpointLockSync(successor)
}

func TestInPlaceSavePreservesFileMode(t *testing.T) {
	root := testRepo(t)
	file := filepath.Join(root, ".hwf", "workflows", "mode.yaml")
	body := "# yaml-language-server: $schema=" + config.WorkflowSchemaURL() + "\n" + v1 + "steps:\n  - run: echo base\n"
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/workflow?name=mode&scope=repo")
	var loaded struct {
		Base string `json:"base"`
	}
	decodeJSON(t, res, &loaded)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "mode", "scope": "repo", "previousName": "mode", "previousScope": "repo",
		"base": loaded.Base, "text": strings.Replace(body, "echo base", "echo kept-mode", 1),
	})
	if put.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", put.StatusCode)
	}
	st, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o", st.Mode().Perm())
	}
	onDisk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(onDisk), "echo kept-mode") {
		t.Fatalf("file = %q", string(onDisk))
	}
}

func TestRenamePUTUndoesDestinationWhenSourceCannotBeRemoved(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	stuck := filepath.Join(wdir, "stuck.yaml")
	if err := os.MkdirAll(stuck, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stuck, "child"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	put := apiJSON(t, s, http.MethodPut, "/api/workflow", map[string]any{
		"name": "moved", "scope": "repo", "previousName": "stuck", "previousScope": "repo",
		"text": v1 + "steps:\n  - run: echo moved\n",
	})
	if put.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", put.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, put, &data)
	if data.OK || !strings.Contains(data.Error, "could not be removed") {
		t.Fatalf("body = %+v", data)
	}
	if _, err := os.Stat(filepath.Join(wdir, "moved.yaml")); !os.IsNotExist(err) {
		t.Fatal("moved.yaml should not exist")
	}
	if _, err := os.Stat(filepath.Join(stuck, "child")); err != nil {
		t.Fatal("stuck child should remain")
	}
}

func TestDropSourceReportsBothFailures(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	src := filepath.Join(wdir, "src.yaml")
	dest := filepath.Join(wdir, "dest.yaml")
	if err := os.MkdirAll(filepath.Join(src, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dest, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := DropSource(src, dest, "src")
	if res.status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.status)
	}
	if !strings.Contains(res.body["error"].(string), "'src' could not be removed") {
		t.Fatalf("error = %v", res.body["error"])
	}
	if !strings.Contains(res.body["error"].(string), "could not be undone") {
		t.Fatalf("error = %v", res.body["error"])
	}
	if !strings.Contains(res.body["orphan"].(string), "dest.yaml") {
		t.Fatalf("orphan = %v", res.body["orphan"])
	}
}

func TestDELETEMissingFileIsIdempotentOK(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	res := apiJSON(t, s, http.MethodDelete, "/api/workflow", map[string]any{"name": "ghost", "scope": "repo"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var data struct {
		OK bool `json:"ok"`
	}
	decodeJSON(t, res, &data)
	if !data.OK {
		t.Fatal("expected ok")
	}
}

func TestDELETEReportsFilesystemFailure(t *testing.T) {
	root := testRepo(t)
	wdir := filepath.Join(root, ".hwf", "workflows")
	if err := os.WriteFile(filepath.Join(wdir, "stuck.yaml"), []byte(v1+"steps:\n  - run: echo stuck\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(wdir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(wdir, 0o755) })
	s := startTestServer(t, root)
	res := apiJSON(t, s, http.MethodDelete, "/api/workflow", map[string]any{"name": "stuck", "scope": "repo"})
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.StatusCode)
	}
	var data struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	decodeJSON(t, res, &data)
	if data.OK {
		t.Fatal("expected failure")
	}
	if !strings.Contains(strings.ToLower(data.Error), "permission") && !strings.Contains(data.Error, "EACCES") {
		t.Fatalf("error = %q", data.Error)
	}
	if _, err := os.Stat(filepath.Join(wdir, "stuck.yaml")); err != nil {
		t.Fatal("stuck.yaml should remain")
	}
}

func TestShareReturnsCommandAndProvenance(t *testing.T) {
	root := testRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "handoff.yaml"), []byte(v1+"steps:\n  - run: echo hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	res := apiGet(t, s, "/api/share?name=handoff&scope=repo")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var data struct {
		OK      bool `json:"ok"`
		Command string
		Entries []struct {
			Name string `json:"name"`
			YAML string `json:"yaml"`
		} `json:"entries"`
		Provenance []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"provenance"`
	}
	decodeJSON(t, res, &data)
	if !data.OK || !strings.HasPrefix(data.Command, `hwf workflow import "`) {
		t.Fatalf("command = %q", data.Command)
	}
	if len(data.Entries) != 1 || data.Entries[0].Name != "handoff" || data.Entries[0].YAML != v1+"steps:\n  - run: echo hi\n" {
		t.Fatalf("entries = %+v", data.Entries)
	}
	if len(data.Provenance) != 1 || data.Provenance[0].Name != "handoff" || data.Provenance[0].Source != "repo" {
		t.Fatalf("provenance = %+v", data.Provenance)
	}
	raw, _ := json.Marshal(data.Entries)
	if strings.Contains(string(raw), `"source"`) {
		t.Fatal("entries should not encode source")
	}
}

func TestImportPreviewAcceptsCommandAndRejectsOldPayload(t *testing.T) {
	root := testRepo(t)
	s := startTestServer(t, root)
	payload, err := workflow.EncodePayload(workflow.WorkflowBundle{{Name: "demo", YAML: v1 + "steps:\n  - run: x\n"}})
	if err != nil {
		t.Fatal(err)
	}
	ok := apiJSON(t, s, http.MethodPost, "/api/import/preview", map[string]any{"text": workflow.FormatImportCommand(payload)})
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", ok.StatusCode)
	}
	var preview struct {
		OK      bool `json:"ok"`
		Entries []struct {
			Name string `json:"name"`
		} `json:"entries"`
	}
	decodeJSON(t, ok, &preview)
	if !preview.OK || preview.Entries[0].Name != "demo" {
		t.Fatalf("preview = %+v", preview)
	}
	oldPayload, err := encodeLegacyPayload(t, map[string]any{"v": 1, "name": "demo", "body": v1 + "steps:\n  - run: x\n"})
	if err != nil {
		t.Fatal(err)
	}
	rejected := apiJSON(t, s, http.MethodPost, "/api/import/preview", map[string]any{"text": oldPayload})
	if rejected.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", rejected.StatusCode)
	}
	var bad struct {
		Error string `json:"error"`
	}
	decodeJSON(t, rejected, &bad)
	if !strings.Contains(bad.Error, "removed single-workflow") {
		t.Fatalf("error = %q", bad.Error)
	}
}

func encodeLegacyPayload(t *testing.T, v any) (string, error) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(data); err != nil {
		return "", err
	}
	if err := gw.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func TestImportRequiresReplaceAllOnConflict(t *testing.T) {
	root := testRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".hwf", "workflows", "demo.yaml"), []byte(v1+"steps:\n  - run: mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := startTestServer(t, root)
	payload, err := workflow.EncodePayload(workflow.WorkflowBundle{{Name: "demo", YAML: v1 + "steps:\n  - run: new\n"}})
	if err != nil {
		t.Fatal(err)
	}
	conflict := apiJSON(t, s, http.MethodPost, "/api/import", map[string]any{"text": payload, "scope": "repo"})
	if conflict.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", conflict.StatusCode)
	}
	mine, err := os.ReadFile(filepath.Join(root, ".hwf", "workflows", "demo.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mine), "mine") {
		t.Fatal("original should remain")
	}
	replaced := apiJSON(t, s, http.MethodPost, "/api/import", map[string]any{"text": payload, "scope": "repo", "replaceAll": true})
	if replaced.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", replaced.StatusCode)
	}
	after, err := os.ReadFile(filepath.Join(root, ".hwf", "workflows", "demo.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(after), "new") {
		t.Fatalf("file = %q", string(after))
	}
}
