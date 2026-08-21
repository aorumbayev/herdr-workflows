package engine

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// PlacedPane is the pane/tab/workspace identifier triple.
type PlacedPane = workflow.ReadinessResult

// PlaceOpts specifies pane placement parameters.
type PlaceOpts struct {
	Open       string
	Anchor     string
	Workspace  string
	Size       *int
	Focus      bool
	Cwd        string
	Env        map[string]string
	Label      string
	Argv       []string
	Deps       RunnerDeps
	Invocation config.InvocationContext
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func SizeToFirstRatio(sizePercent int) float64 {
	return float64(100-sizePercent) / 100.0
}

func failPlacement(detail string) error {
	return &host.HerdrError{Code: "placement_failed", Msg: detail}
}

func requireWorkspace(o PlaceOpts) (string, error) {
	workspace := o.Workspace
	if workspace == "" {
		workspace = o.Invocation.WorkspaceID
	}
	if workspace == "" {
		return "", failPlacement("pane.open: tab needs pane.workspace or an invocation workspace")
	}
	return workspace, nil
}

func requireAnchorPane(o PlaceOpts) (string, error) {
	anchor := o.Anchor
	if anchor == "" {
		anchor = o.Invocation.PaneID
	}
	if anchor == "" {
		return "", failPlacement(fmt.Sprintf("pane.open: %s needs pane.target or an invocation pane", o.Open))
	}
	return anchor, nil
}

func splitDirection(open string) string {
	if open == "beside" {
		return "right"
	}
	return "down"
}

func placedFrom(source any, where string) (PlacedPane, error) {
	m, ok := source.(map[string]any)
	if !ok {
		m = map[string]any{}
	}

	paneID, _ := m["pane_id"].(string)
	tabID, _ := m["tab_id"].(string)
	workspaceID, _ := m["workspace_id"].(string)

	if paneID == "" || tabID == "" || workspaceID == "" {
		return PlacedPane{}, failPlacement(fmt.Sprintf("%s did not return pane/tab/workspace identifiers", where))
	}

	return PlacedPane{
		PaneID:      paneID,
		TabID:       tabID,
		WorkspaceID: workspaceID,
	}, nil
}

func placeEmptyTab(o PlaceOpts) (PlacedPane, error) {
	workspace, err := requireWorkspace(o)
	if err != nil {
		return PlacedPane{}, err
	}

	env := o.Env
	if env == nil {
		env = map[string]string{}
	}

	params := map[string]any{
		"workspace_id": workspace,
		"cwd":          nullableStr(o.Cwd),
		"env":          env,
		"focus":        o.Focus,
		"label":        nullableStr(o.Label),
	}

	result, err := o.Deps.HerdrCall("tab.create", params)
	if err != nil {
		return PlacedPane{}, err
	}

	tab, _ := result["tab"].(map[string]any)
	rootPane, _ := result["root_pane"].(map[string]any)

	pane, err := placedFrom(rootPane, "tab.create")
	if err != nil {
		return PlacedPane{}, err
	}

	tabID := pane.TabID
	workspaceID := pane.WorkspaceID
	if tabIDFromTab, ok := tab["tab_id"].(string); ok {
		tabID = tabIDFromTab
	}
	if workspaceIDFromTab, ok := tab["workspace_id"].(string); ok {
		workspaceID = workspaceIDFromTab
	}

	return PlacedPane{
		PaneID:      pane.PaneID,
		TabID:       tabID,
		WorkspaceID: workspaceID,
	}, nil
}

// PlaceEmptyPane creates an empty pane for a managed agent.
func PlaceEmptyPane(o PlaceOpts) (PlacedPane, error) {
	if o.Open == "tab" {
		return placeEmptyTab(o)
	}

	anchor, err := requireAnchorPane(o)
	if err != nil {
		return PlacedPane{}, err
	}

	env := o.Env
	if env == nil {
		env = map[string]string{}
	}

	params := map[string]any{
		"direction":      splitDirection(o.Open),
		"target_pane_id": anchor,
		"ratio":          nil,
		"cwd":            nullableStr(o.Cwd),
		"env":            env,
		"focus":          o.Focus,
	}

	if o.Size != nil {
		params["ratio"] = SizeToFirstRatio(*o.Size)
	}

	result, err := o.Deps.HerdrCall("pane.split", params)
	if err != nil {
		return PlacedPane{}, err
	}

	pane, _ := result["pane"].(map[string]any)
	return placedFrom(pane, "pane.split")
}

// PlaceCommandPane creates a pane running a command.
func PlaceCommandPane(o PlaceOpts) (PlacedPane, error) {
	if o.Open == "tab" {
		workspace, err := requireWorkspace(o)
		if err != nil {
			return PlacedPane{}, err
		}

		env := o.Env
		if env == nil {
			env = map[string]string{}
		}

		params := map[string]any{
			"workspace_id": workspace,
			"tab_label":    nullableStr(o.Label),
			"tab_id":       nil,
			"focus":        o.Focus,
			"root": map[string]any{
				"type":    "pane",
				"label":   nullableStr(o.Label),
				"cwd":     nullableStr(o.Cwd),
				"command": o.Argv,
				"env":     env,
			},
		}

		result, err := o.Deps.HerdrCall("layout.apply", params)
		if err != nil {
			return PlacedPane{}, err
		}

		return createdPaneFromLayout(result, false)
	}

	placed, err := PlaceEmptyPane(o)
	if err != nil {
		return PlacedPane{}, err
	}

	text := QuoteArgvForShell(o.Argv)
	params := map[string]any{
		"pane_id": placed.PaneID,
		"text":    text,
		"keys":    []string{"Enter"},
	}

	_, err = o.Deps.HerdrCall("pane.send_input", params)
	if err != nil {
		return PlacedPane{}, err
	}

	return placed, nil
}

func createdPaneFromLayout(result map[string]any, split bool) (PlacedPane, error) {
	layout, _ := result["layout"].(map[string]any)

	tabID, _ := layout["tab_id"].(string)
	workspaceID, _ := layout["workspace_id"].(string)

	if tabID == "" || workspaceID == "" {
		return PlacedPane{}, failPlacement("layout.apply did not return tab/workspace identifiers")
	}

	paneID, err := createdPaneID(layout, split)
	if err != nil {
		return PlacedPane{}, err
	}

	return PlacedPane{
		PaneID:      paneID,
		TabID:       tabID,
		WorkspaceID: workspaceID,
	}, nil
}

func createdPaneID(layout map[string]any, split bool) (string, error) {
	var node map[string]any
	if split {
		root, _ := layout["root"].(map[string]any)
		second, _ := root["second"].(map[string]any)
		node = second
	} else {
		root, _ := layout["root"].(map[string]any)
		node = root
	}

	if paneID, ok := node["pane_id"].(string); ok && paneID != "" {
		return paneID, nil
	}

	if focusedID, ok := layout["focused_pane_id"].(string); ok && focusedID != "" {
		return focusedID, nil
	}

	return "", failPlacement("layout.apply did not return the created pane id")
}

// QuoteArgvForShell quotes a command array for shell execution.
func QuoteArgvForShell(argv []string) string {
	parts := make([]string, len(argv))
	for i, arg := range argv {
		parts[i] = QuotePosixArg(arg)
	}
	return strings.Join(parts, " ")
}

// QuotePosixArg quotes a single shell argument for POSIX shells.
func QuotePosixArg(value string) string {
	if value == "" {
		return "''"
	}

	// regex: ^[A-Za-z0-9_./:=+-]+$
	isSafe := regexp.MustCompile(`^[A-Za-z0-9_./:=+-]+$`).MatchString(value)
	if isSafe {
		return value
	}

	// Single-quote with escaped internal single quotes
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// ResolvePaneLabel resolves a pane name template, falling back to the step ID if blank.
func ResolvePaneLabel(name string, ns workflow.TemplateNamespace, fallback string) string {
	if name == "" {
		return fallback
	}

	rendered := workflow.SubstituteText(name, ns)
	rendered = strings.TrimSpace(rendered)
	if rendered == "" {
		return fallback
	}

	return rendered
}

// ResolvePaneOpen validates and resolves a pane.open value.
func ResolvePaneOpen(open string, ns workflow.TemplateNamespace) (string, error) {
	if slices.Contains(workflow.PaneOpens, open) {
		return open, nil
	}

	resolved := workflow.SubstituteValue(open, ns)
	resolvedStr := workflow.RenderScalar(resolved)

	if slices.Contains(workflow.PaneOpens, resolvedStr) {
		return resolvedStr, nil
	}

	return "", fmt.Errorf("pane.open resolved to '%s' (expected tab, beside, or below)", resolvedStr)
}
