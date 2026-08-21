package workbench

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func scopeOf(v any) string {
	s, _ := v.(string)
	if s == "repo" || s == "global" {
		return s
	}
	return ""
}

func decodeBody(r *http.Request) map[string]any {
	if r.Body == nil {
		return map[string]any{}
	}
	defer func() { _ = r.Body.Close() }()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
		return map[string]any{}
	}
	if body == nil {
		return map[string]any{}
	}
	return body
}

func strField(body map[string]any, key string) string {
	v, _ := body[key].(string)
	return v
}

func requireNameScope(name, scope string) *saveResult {
	if !workflow.NameRE.MatchString(name) || scope == "" {
		return saveErr(400, "name and scope required")
	}
	return nil
}

func (s *Server) handleWorkflow(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		name := r.URL.Query().Get("name")
		scope := scopeOf(r.URL.Query().Get("scope"))
		if bad := requireNameScope(name, scope); bad != nil {
			writeJSON(w, bad.status, bad.body)
			return
		}
		file, err := workflow.WorkflowPath(scope, s.repoRoot, name)
		if err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		data, err := os.ReadFile(file)
		text := ""
		if err == nil {
			text = string(data)
		} else if !os.IsNotExist(err) {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		valid := true
		var loadErr string
		if text != "" {
			cfg, cfgErr := config.LoadConfig(s.repoRoot, os.Getenv)
			if cfgErr != nil {
				writeJSON(w, 500, map[string]any{"ok": false, "error": cfgErr.Error()})
				return
			}
			if _, parseErr := workflow.ParseWorkflowText(name, text, cfg, s.repoRoot, name+".yaml"); parseErr != nil {
				valid = false
				loadErr = parseErr.Error()
			}
		}
		flags := sensitivityFlagsForText(name, text, s.repoRoot)
		resp := map[string]any{"text": text, "valid": valid, "flags": flags}
		if loadErr != "" {
			resp["error"] = loadErr
		}
		if text != "" {
			resp["base"] = contentToken(text)
		}
		writeJSON(w, 200, resp)
	case http.MethodPut:
		body := decodeBody(r)
		scope := scopeOf(body["scope"])
		if scope == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "scope required"})
			return
		}
		prevName := strField(body, "previousName")
		prevScope := scopeOf(body["previousScope"])
		var previous *scopeRef
		if prevName != "" || body["previousScope"] != nil {
			if !workflow.NameRE.MatchString(prevName) || prevScope == "" {
				writeJSON(w, 400, map[string]any{"ok": false, "error": "previousName and previousScope required"})
				return
			}
			previous = &scopeRef{name: prevName, scope: prevScope}
		}
		base := strField(body, "base")
		res := writeWorkflow(s.repoRoot, strField(body, "name"), scope, strField(body, "text"), previous, base)
		writeJSON(w, res.status, res.body)
	case http.MethodDelete:
		body := decodeBody(r)
		name := strField(body, "name")
		scope := scopeOf(body["scope"])
		if bad := requireNameScope(name, scope); bad != nil {
			writeJSON(w, bad.status, bad.body)
			return
		}
		file, err := workflow.WorkflowPath(scope, s.repoRoot, name)
		if err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	var scope string
	var body map[string]any
	if r.Method == http.MethodGet {
		scope = scopeOf(r.URL.Query().Get("scope"))
	} else {
		body = decodeBody(r)
		scope = scopeOf(body["scope"])
	}
	if scope == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "scope required"})
		return
	}
	var file string
	var err error
	if scope == "repo" {
		file = config.RepoConfigPath(s.repoRoot)
	} else {
		file, err = config.GlobalConfigPath(os.Getenv)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}
	switch r.Method {
	case http.MethodGet:
		data, readErr := os.ReadFile(file)
		text := ""
		if readErr == nil {
			text = string(data)
		} else if !os.IsNotExist(readErr) {
			writeJSON(w, 500, map[string]any{"ok": false, "error": readErr.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"text": text})
	case http.MethodPut:
		text := strField(body, "text")
		if _, err := config.ParseConfigText(file, text); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if st, statErr := os.Lstat(file); statErr == nil && st.Mode()&os.ModeSymlink != 0 {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "refusing symlinked " + scope + " config file; edit its target directly"})
			return
		}
		trustedBase := s.repoRoot
		if scope != "repo" {
			trustedBase = filepath.Dir(file)
		}
		if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, scope+" config", "config root"); unsafe != nil {
			writeJSON(w, unsafe.status, unsafe.body)
			return
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if unsafe := refuseUnsafeWorkflowPath(file, trustedBase, scope+" config", "config root"); unsafe != nil {
			writeJSON(w, unsafe.status, unsafe.body)
			return
		}
		tmp := filepath.Join(filepath.Dir(file), ".config."+newLockToken()+".tmp")
		mode := existingFileMode(file)
		if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if err := os.Rename(tmp, file); err != nil {
			_ = os.Remove(tmp)
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := r.URL.Query().Get("name")
	scope := scopeOf(r.URL.Query().Get("scope"))
	if bad := requireNameScope(name, scope); bad != nil {
		writeJSON(w, bad.status, bad.body)
		return
	}
	exported, err := workflow.ExportWorkflowBundle(name, scope, s.repoRoot)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	entries := make([]map[string]string, 0, len(exported.Entries))
	for _, e := range exported.Entries {
		entries = append(entries, map[string]string{"name": e.Name, "yaml": e.YAML})
	}
	provenance := make([]map[string]string, 0, len(exported.Provenance))
	for _, p := range exported.Provenance {
		provenance = append(provenance, map[string]string{"name": p.Name, "source": p.Source})
	}
	writeJSON(w, 200, map[string]any{
		"ok":         true,
		"command":    exported.Command,
		"payload":    exported.Payload,
		"entries":    entries,
		"provenance": provenance,
	})
}

func importName(body map[string]any) string {
	name := strings.TrimSpace(strField(body, "name"))
	if name == "" {
		return ""
	}
	return name
}

func (s *Server) handleImportPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := decodeBody(r)
	text := strField(body, "text")
	name := importName(body)
	var bundle workflow.WorkflowBundle
	var err error
	if name != "" {
		bundle, err = workflow.CheckPayload(text, name)
	} else {
		bundle, err = workflow.CheckPayload(text)
	}
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	preview, err := workflow.PreviewBundle(bundle)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	home, err := config.HomeDir(os.Getenv)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	repoConflicts, err := workflow.PreflightConflicts(bundle, filepath.Join(s.repoRoot, ".hwf", "workflows"))
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	globalConflicts, err := workflow.PreflightConflicts(bundle, filepath.Join(home, ".hwf", "workflows"))
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":                 true,
		"entries":            preview.Entries,
		"warnings":           preview.Warnings,
		"unresolvedChildren": preview.UnresolvedChildren,
		"banner":             preview.Banner,
		"availability": map[string]any{
			"repo":   map[string]any{"conflicts": repoConflicts},
			"global": map[string]any{"conflicts": globalConflicts},
		},
	})
}

func (s *Server) handleImportWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := decodeBody(r)
	scopeRaw := strField(body, "scope")
	scope, ok := workflow.ParseImportScope(scopeRaw)
	if !ok {
		scope = workflow.ImportScope(scopeOf(body["scope"]))
	}
	if scope == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "scope required"})
		return
	}
	replaceAll := body["replaceAll"] == true || body["force"] == true
	outcome, err := workflow.RunImport(strField(body, "text"), workflow.RunImportOptions{
		RepoRoot: s.repoRoot,
		Scope:    scope,
		Force:    replaceAll,
		Name:     importName(body),
	})
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if outcome.Aborted {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "aborted"})
		return
	}
	if outcome.Result.Status == "conflicts" {
		writeJSON(w, 409, map[string]any{
			"ok":        false,
			"error":     "existing workflows require replace-all confirmation",
			"conflicts": outcome.Result.Conflicts,
		})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "results": outcome.Result.Results})
}
