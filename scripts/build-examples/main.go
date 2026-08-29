// Command build-examples writes example gallery cards as JSON for VitePress.
//
//	go run ./scripts/build-examples [examples-dir]
//
// When there is no argument, the command uses examples/ in the repository root.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/aorumbayev/herdr-workflows/scripts/internal/reporoot"
)

type ExampleCard struct {
	Name    string `json:"name"`
	Desc    string `json:"desc"`
	Body    string `json:"body"`
	Payload string `json:"payload"`
}

type exampleSource struct {
	body string
	raw  workflow.Document
}

func defaultExamplesDir() (string, error) {
	root, err := reporoot.Find()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "examples"), nil
}

func BuildExamples(dir string) ([]ExampleCard, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}
		names = append(names, strings.TrimSuffix(entry.Name(), ".yaml"))
	}
	sort.Strings(names)

	sources := make(map[string]exampleSource, len(names))
	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dir, name+".yaml"))
		if err != nil {
			return nil, err
		}
		raw, err := workflow.ParseRaw(name+".yaml", string(body))
		if err != nil {
			return nil, err
		}
		sources[name] = exampleSource{body: string(body), raw: raw}
	}

	var cards []ExampleCard
	for _, name := range names {
		source := sources[name]
		if source.raw.Hidden {
			continue
		}
		order, err := collectBundle(name, sources)
		if err != nil {
			return nil, err
		}
		bundle := make(workflow.Bundle, len(order))
		for i, entry := range order {
			bundle[i] = workflow.BundleEntry{Name: entry, YAML: sources[entry].body}
		}
		payload, err := workflow.EncodePayload(bundle)
		if err != nil {
			return nil, err
		}
		cards = append(cards, ExampleCard{
			Name:    name,
			Desc:    source.raw.Description,
			Body:    source.body,
			Payload: payload,
		})
	}
	return cards, nil
}

func collectBundle(name string, sources map[string]exampleSource) ([]string, error) {
	seen := map[string]bool{}
	var order []string
	var walk func(string) error
	walk = func(current string) error {
		if seen[current] {
			return nil
		}
		seen[current] = true
		source, ok := sources[current]
		if !ok {
			return fmt.Errorf("example '%s' references missing child workflow", current)
		}
		order = append(order, current)
		for _, child := range workflow.ReferencedWorkflowChildren(source.raw) {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(name); err != nil {
		return nil, err
	}
	return order, nil
}

func main() {
	dir, err := defaultExamplesDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	cards, err := BuildExamples(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out, err := json.Marshal(cards)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
