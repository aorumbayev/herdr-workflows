package workbench

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"gopkg.in/yaml.v3"
)

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cfg, err := config.LoadConfig(s.repoRoot, os.Getenv)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	profiles := config.ProfileNames(cfg)
	entries, err := workflow.ListWorkflows(s.repoRoot, cfg)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	mapped := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		flags := workflow.SensitivityLabels(workflow.WorkflowSensitivity{
			HasCommands:        entry.HasCommands,
			HasTranscript:      entry.NeedsTranscript,
			SensitiveMethods:   entry.SensitiveMethods,
			UnresolvedChildren: entry.UnresolvedChildren,
		})
		provenance := entry.Source
		if provenance != "repo" {
			provenance = "global"
		}
		inRepo := fileExists(workflowPathOrEmpty("repo", s.repoRoot, entry.Name))
		inGlobal := fileExists(workflowPathOrEmpty("global", s.repoRoot, entry.Name))
		mapped = append(mapped, map[string]any{
			"name":        entry.Name,
			"title":       workflow.WorkflowDisplayTitle(entry.Name, entry.Title),
			"description": entry.Description,
			"source":      entry.Source,
			"provenance":  provenance,
			"valid":       entry.Error == "",
			"hidden":      entry.Hidden,
			"flags":       flags,
			"inRepo":      inRepo,
			"inGlobal":    inGlobal,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"repoRoot":          shortPath(s.repoRoot),
		"canonicalRepoRoot": s.repoRoot,
		"profiles":          profiles,
		"entries":           mapped,
		"workflowSchemaUrl": config.WorkflowSchemaURL(),
	})
}

func (s *Server) handleSchema(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var schema any
	if err := json.Unmarshal([]byte(assets.WorkflowSchemaJSON), &schema); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	writeJSON(w, http.StatusOK, schema)
}

func (s *Server) handleMethods(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"methods": host.MethodCatalog()})
}

func (s *Server) handleParse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := decodeBody(r)
	text, _ := body["text"].(string)
	doc, err := workflow.ParseRawWithDoc("buffer.yaml", text)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "doc": doc})
}

func (s *Server) handleFormat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := decodeBody(r)
	doc, ok := body["doc"].(map[string]any)
	if !ok || doc == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "doc must be an object"})
		return
	}
	if issues := workflow.ValidateDocMap(doc); len(issues) > 0 {
		messages := make([]string, len(issues))
		for i, issue := range issues {
			messages[i] = issue.Message
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":     false,
			"error":  strings.Join(messages, "; "),
			"issues": issues,
		})
		return
	}
	yamlText, err := yaml.Marshal(doc)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	raw, err := workflow.ParseRaw("buffer.yaml", string(yamlText))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	formatted, err := workflow.DumpWorkflow(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	formatted = polishFormattedYAML(formatted)
	if _, err := workflow.ParseRaw("buffer.yaml", formatted); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "text": formatted})
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := decodeBody(r)
	name, _ := body["name"].(string)
	if name == "" {
		name = "buffer"
	}
	text, _ := body["text"].(string)
	flags := sensitivityFlagsForText(name, text, s.repoRoot)
	cfg, err := config.LoadConfig(s.repoRoot, os.Getenv)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": errText(err)})
		return
	}
	if _, err := workflow.ParseWorkflowText(name, text, cfg, s.repoRoot, name+".yaml"); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": errText(err), "flags": flags})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "flags": flags})
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func sensitivityFlagsForText(name, text, repoRoot string) []string {
	if text == "" {
		return nil
	}
	flags, err := workflow.AnalyzeYamlTree(name+".yaml", text, name, repoRoot)
	if err != nil {
		return nil
	}
	return workflow.SensitivityLabels(flags)
}

func workflowPathOrEmpty(scope, repoRoot, name string) string {
	path, err := workflow.WorkflowPath(scope, repoRoot, name)
	if err != nil {
		return ""
	}
	return path
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func polishFormattedYAML(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines)+4)
	inSteps := false
	stepItems := 0
	for _, line := range lines {
		if line == "steps:" {
			inSteps = true
			stepItems = 0
			out = append(out, line)
			continue
		}
		if inSteps && strings.HasPrefix(line, "    - ") {
			if stepItems > 0 {
				out = append(out, "")
			}
			out = append(out, "  "+strings.TrimPrefix(line, "    "))
			stepItems++
			continue
		}
		if inSteps && line != "" && !strings.HasPrefix(line, " ") {
			inSteps = false
		}
		if strings.HasPrefix(line, "    ") {
			out = append(out, "  "+strings.TrimPrefix(line, "    "))
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
