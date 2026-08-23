package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// InvocationContext carries the pane identity herdr injected for this run.
type InvocationContext struct {
	WorkspaceID  string
	TabID        string
	PaneID       string
	WorktreePath string
	Selection    string
	Cwd          string
}

type ctxJSON struct {
	WorkspaceID    string `json:"workspace_id"`
	TabID          string `json:"tab_id"`
	FocusedPaneID  string `json:"focused_pane_id"`
	FocusedPaneCwd string `json:"focused_pane_cwd"`
	PaneID         string `json:"pane_id"`
	SelectedText   string `json:"selected_text"`
	Cwd            string `json:"cwd"`
	Worktree       struct {
		Path string `json:"path"`
	} `json:"worktree"`
	Workspace struct {
		WorkspaceID string `json:"workspace_id"`
		Cwd         string `json:"cwd"`
	} `json:"workspace"`
	Tab struct {
		TabID string `json:"tab_id"`
	} `json:"tab"`
	Pane struct {
		PaneID string `json:"pane_id"`
	} `json:"pane"`
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func readInvocationContext(getenv Env) InvocationContext {
	env := envOr(getenv)
	var injected ctxJSON
	if raw := env("HERDR_PLUGIN_CONTEXT_JSON"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &injected)
	}
	cwd, _ := os.Getwd()
	return InvocationContext{
		WorkspaceID:  firstNonEmpty(env("HERDR_WORKSPACE_ID"), injected.WorkspaceID, injected.Workspace.WorkspaceID),
		TabID:        firstNonEmpty(env("HERDR_TAB_ID"), injected.TabID, injected.Tab.TabID),
		PaneID:       firstNonEmpty(env("HERDR_PANE_ID"), injected.FocusedPaneID, injected.PaneID, injected.Pane.PaneID),
		WorktreePath: injected.Worktree.Path,
		Selection:    injected.SelectedText,
		Cwd:          firstNonEmpty(injected.Worktree.Path, injected.FocusedPaneCwd, injected.Cwd, injected.Workspace.Cwd, cwd),
	}
}

// ResolveRepoRoot walks up from start looking for .git or .hwf.
func ResolveRepoRoot(start string) string {
	dir := start
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		if _, err := os.Stat(filepath.Join(dir, ".hwf")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return start
		}
		dir = parent
	}
}

// AppContext is the resolved config, repo root, and invocation context.
type AppContext struct {
	Config   Config
	RepoRoot string
	Ctx      InvocationContext
}

// LoadOptions tune LoadContext.
type LoadOptions struct {
	Start          string
	RepoRoot       string
	FromInvocation bool
	Env            Env
}

// LoadContext resolves config layers, repo root, and invocation context once.
func LoadContext(opts LoadOptions) (AppContext, error) {
	env := envOr(opts.Env)
	invocation := readInvocationContext(env)
	start := opts.Start
	if start == "" {
		if opts.FromInvocation {
			start = invocation.Cwd
		} else {
			start, _ = os.Getwd()
		}
	}
	repoRoot := opts.RepoRoot
	if repoRoot == "" {
		repoRoot = env("HERDR_WORKFLOWS_REPO_ROOT")
	}
	if repoRoot == "" {
		repoRoot = ResolveRepoRoot(start)
	}
	ctx := invocation
	ctx.Cwd = repoRoot
	cfg, err := LoadConfig(repoRoot, env)
	if err != nil {
		return AppContext{}, err
	}
	return AppContext{Config: cfg, RepoRoot: repoRoot, Ctx: ctx}, nil
}
