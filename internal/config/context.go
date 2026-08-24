package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// InvocationContext holds the pane identity that herdr injected for this run.
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
	WorkspaceCwd   string `json:"workspace_cwd"`
	Worktree       struct {
		CheckoutPath string `json:"checkout_path"`
	} `json:"worktree"`
	Workspace struct {
		WorkspaceID string `json:"workspace_id"`
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
		WorktreePath: injected.Worktree.CheckoutPath,
		Selection:    injected.SelectedText,
		Cwd:          firstNonEmpty(injected.Worktree.CheckoutPath, injected.FocusedPaneCwd, injected.WorkspaceCwd, cwd),
	}
}

// ResolveRepoRoot finds .git in parent directories from start, or .hwf that is
// not in the home directory. .hwf is the global directory of the plugin.
func ResolveRepoRoot(start string) string {
	home, _ := HomeDir(nil)
	dir := start
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		if dir != home {
			if _, err := os.Stat(filepath.Join(dir, ".hwf")); err == nil {
				return dir
			}
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

// LoadOptions holds parameters for LoadContext.
type LoadOptions struct {
	Start          string
	RepoRoot       string
	FromInvocation bool
	Env            Env
}

// LoadContext finds config layers, repo root, and invocation context one time.
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
