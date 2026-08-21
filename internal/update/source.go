package update

import (
	"encoding/json"
	"fmt"
)

type PluginSourceInfo struct {
	Kind  string
	Owner string
	Repo  string
}

func ParsePluginListSource(jsonText string) (PluginSourceInfo, error) {
	var parsed any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		return PluginSourceInfo{}, fmt.Errorf("herdr plugin list returned invalid JSON")
	}
	plugin := findHerdrWorkflowsPlugin(parsed)
	if plugin == nil {
		return PluginSourceInfo{Kind: "unregistered"}, nil
	}
	src := plugin["source"]
	srcMap, ok := src.(map[string]any)
	if !ok {
		return PluginSourceInfo{Kind: "local"}, nil
	}
	kind, _ := srcMap["kind"].(string)
	if kind == "github" {
		owner, _ := srcMap["owner"].(string)
		repo, _ := srcMap["repo"].(string)
		return PluginSourceInfo{Kind: "github", Owner: nonempty(owner), Repo: nonempty(repo)}, nil
	}
	return PluginSourceInfo{Kind: "local"}, nil
}

func findHerdrWorkflowsPlugin(parsed any) map[string]any {
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	var result map[string]any
	if r, ok := obj["result"].(map[string]any); ok {
		result = r
	} else if t, _ := obj["type"].(string); t == "plugin_list" {
		result = obj
	}
	if result == nil {
		return nil
	}
	if t, _ := result["type"].(string); t != "plugin_list" {
		return nil
	}
	plugins, ok := result["plugins"].([]any)
	if !ok {
		return nil
	}
	for _, entry := range plugins {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["plugin_id"].(string)
		if id == "herdr-workflows" {
			return m
		}
	}
	return nil
}

func nonempty(s string) string {
	return s
}
