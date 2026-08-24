---
name: herdr-workflow-upgrade
description: Updates a repo's existing .hwf/workflows/*.yaml for the latest herdr and herdr-workflows releases. Use when the user asks to upgrade, migrate, or repair existing hwf workflows after a herdr update, when a workflow that used to run now fails, or when the plugin refuses the running herdr version or protocol.
---

# Upgrade herdr-workflows workflows

Repairs existing v1alpha1 workflows against the running herdr. Gates run in a strict order —
herdr version, plugin compatibility, interview, YAML — and a failed gate ends the session on
the spot: report the gate's outcome and stop. While a gate is failing, do not read the breakage
reference, do not interview, and do not open or edit any workflow file. Every version claim
needs quoted command output: run the command, never assert a version or a changelog entry from
memory.

Full v1alpha1 syntax is the sibling skill's job — `hwf skills show herdr-workflow-create` prints
it. This skill owns the version gates and the three herdr breakage classes introduced at 0.8.0
(current plugin floor is 0.8.2).

## Workflow

```
- [ ] 1. herdr version gate: installed vs latest release, quoted output
- [ ] 2. Plugin compatibility gate: startup refusal → `hwf update`
- [ ] 3. Interview: scope, invariants, apply policy (no edits before answers)
- [ ] 4. Scan .hwf/workflows/*.yaml and repair the three breakage classes
- [ ] 5. Oracle: `hwf workflow inspect <name>` exits 0 on every touched file
```

### 1. herdr version gate

```bash
herdr --version
curl -fsSL https://api.github.com/repos/herdrdev/herdr/releases/latest | grep tag_name
```

Quote both outputs. Installed behind the latest release → the session ends here. Tell the user
to update through their install method:

- install script: `curl -fsSL https://herdr.dev/install.sh | sh` (an installer-managed install
  can also run `herdr update`)
- Homebrew: `brew upgrade herdr`
- mise: `mise upgrade herdr`

The running server must restart before the new version serves, and a restart exits its pane
processes, so the timing is the user's: `herdr server stop`, then start herdr again. Do not run
the restart for them. The final message is the update instruction plus the restart warning —
no interview, no workflow reads, no edits.

### 2. Plugin compatibility gate

On the latest herdr, exercise the plugin with a command that runs the version and protocol
preflight: `hwf run <name>` on any existing workflow, or `hwf picker`. `hwf workflow inspect`
never contacts herdr, so it cannot surface the refusal. A refusal names the installed and
required versions and both protocols, in this shape:

```
herdr protocol mismatch: connected=21, pinned=20 (installed=0.9.0, required≥0.8.2)
```

Refused → check whether a compatible plugin release exists. The refusal is a build
incompatibility between the plugin and the running herdr, never a workflow-authoring problem:
workflow YAML declares no herdr version or protocol, so old YAML cannot cause it and no YAML
edit can resolve it.

```bash
hwf update
```

- It updates → verify with `hwf run <name>` or `hwf picker`, then continue to the interview.
- Already on the latest plugin release and still refused → the session ends here. Tell the user
  to open an issue on `aorumbayev/herdr-workflows` quoting the exact installed/required
  versions and both protocol numbers. Never patch the plugin and never edit workflows to route
  around a protocol refusal. No interview, no workflow reads, no edits.

### 3. Interview — before any edit

Ask once in a single turn (skip answers already given). Prefer the host's structured question UI
when available. Otherwise ask conversationally:

- **Scope** — every workflow in `.hwf/workflows/`, or a named subset? Global `~/.hwf/workflows/`
  as well?
- **Invariants** — which behavior must not change? (step order, picker prompts, pane layout,
  notifications)
- **Apply policy** — apply param and name changes automatically, or confirm each edit first?

No Edit/Write on any file under `.hwf/workflows/` or `~/.hwf/workflows/` before these answers
are in. When the host cannot answer mid-session, stop after asking.

### 4. Scan and refine

Read every in-scope YAML. The three herdr breakage classes introduced at 0.8.0 (still required
on the current 0.8.2 floor), with before/after pairs:

**[reference/herdr-0.8.0.md](reference/herdr-0.8.0.md)**

1. **Worktree selectors** — `worktree.create` / `worktree.open` / `worktree.list` take exactly
   one of `workspace_id` or `cwd`, and `workspace_id` resolves only for worktree-backed
   workspaces. Pass `cwd: "{{context.cwd}}"` — always set to the invocation's project root.
2. **`agent.start` names** — `name` must be unique across the session, so a hardcoded name
   collides on the second run. Derive it per pane in a prior `run:` step.
3. **`herdr … | jq` pipelines** — the pipeline's exit status is jq's, and jq exits 0 on empty
   input, so a herdr failure vanishes. Capture output into a variable under `set -eu`, then pipe
   the variable into jq.

Apply the minimum edit per file. This is a compatibility pass, not a redesign — keep step order,
prompts, and layout unless the user named them in the interview.

### 5. Oracle — every refined file must load

From the project root:

```bash
hwf workflow inspect <name>
```

Exit 0 with printed input metadata means the file loads. Re-inspect after every fix and quote
the result. A file that still fails to load is not finished. The error names the exact key.
