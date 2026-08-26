---
name: herdr-workflow-upgrade
description: Updates a repo's existing .hwf/workflows/*.yaml for the latest herdr and herdr-workflows releases. Use when the user asks to upgrade, migrate, or repair existing hwf workflows after a herdr update, when a workflow that used to run now fails, or when the plugin refuses the running herdr version or protocol.
---

# Upgrade herdr-workflows workflows

Repair existing v1alpha1 workflows against the current herdr. Gates run in this order:
herdr version, plugin compatibility, interview, YAML. A failed gate ends the session at once:
report the gate outcome and stop. While a gate fails, do not read the breakage reference,
do not interview, and do not open or edit any workflow file. Every version claim needs quoted
command output. Run the command. Do not assert a version or a changelog entry from memory.

Full v1alpha1 syntax is the sibling skill. Print it with `hwf skills show herdr-workflow-create`.
This skill owns the version gates and the three herdr breakage classes introduced at 0.8.0
(current plugin floor is 0.8.2).

## Procedure

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

Quote both outputs. If the installed version is behind the latest release, the session ends here.
Tell the user to update through their install method:

- install script: `curl -fsSL https://herdr.dev/install.sh | sh` (an installer-managed install
  can also run `herdr update`)
- Homebrew: `brew upgrade herdr`
- mise: `mise upgrade herdr`

The current server must restart before the new version serves. A restart exits its pane
processes, so the user controls the timing: `herdr server stop`, then start herdr again. Do not run
the restart for them. The final message is the update instruction plus the restart warning.
No interview. No workflow reads. No edits.

### 2. Plugin compatibility gate

On the latest herdr, run a command that runs the version and protocol
preflight: `hwf run <name>` on any existing workflow, or `hwf picker`. `hwf workflow inspect`
never contacts herdr, so it cannot report the refusal. A refusal names the installed and
required versions and both protocols, in this shape:

```
herdr protocol mismatch: connected=21, pinned=20 (installed=0.9.0, required≥0.8.2)
```

If herdr refuses, check whether a compatible plugin release exists. The refusal is a build
incompatibility between the plugin and the current herdr. It is never a problem with the workflow YAML.
Workflow YAML declares no herdr version or protocol. Old YAML cannot cause the refusal. No YAML
edit can resolve it.

```bash
hwf update
```

- If it updates, verify with `hwf run <name>` or `hwf picker`, then continue to the interview.
- If the plugin is already on the latest release and herdr still refuses, the session ends here.
  Tell the user to open an issue on `aorumbayev/herdr-workflows` that quotes the exact installed
  and required versions and both protocol numbers. Never patch the plugin. Never edit workflows
  to avoid a protocol refusal. No interview. No workflow reads. No edits.

### 3. Interview — before any edit

Ask once in a single turn. Skip answers that the user already gave. Prefer the host structured-question UI.
If that UI is absent, ask in conversation:

- **Scope** — every workflow in `.hwf/workflows/`, or a named subset? Global `~/.hwf/workflows/`
  as well?
- **Invariants** — which behavior must not change? (step order, picker prompts, pane layout,
  notifications)
- **Apply policy** — apply param and name changes automatically, or confirm each edit first?

Do not Edit or Write any file under `.hwf/workflows/` or `~/.hwf/workflows/` before these answers
are in. When the host cannot answer mid-session, stop after you ask.

### 4. Scan and repair

Read every in-scope YAML. The three herdr breakage classes introduced at 0.8.0 (still required
on the current 0.8.2 floor), with before and after pairs:

**[reference/herdr-0.8.0.md](reference/herdr-0.8.0.md)**

1. **Worktree selectors** — `worktree.create` / `worktree.open` / `worktree.list` take exactly
   one of `workspace_id` or `cwd`. `workspace_id` resolves only for worktree-backed
   workspaces. Pass `cwd: "{{context.cwd}}"`. That value is always the invocation project root.
2. **`agent.start` names** — `name` must be unique across the session, so a hardcoded name
   collides on the second run. Derive it per pane in a prior `run:` step.
3. **`herdr … | jq` pipelines** — the pipeline exit status is the jq status, and jq exits 0 on empty
   input, so a herdr failure vanishes. Capture output into a variable under `set -eu`, then pipe
   the variable into jq.

Apply the minimum edit per file. This is a compatibility pass, not a redesign. Keep step order,
prompts, and layout unless the user named them in the interview.

### 5. Oracle — every repaired file must load

From the project root:

```bash
hwf workflow inspect <name>
```

Exit 0 with printed input metadata means the file loads. Inspect again after every fix and quote
the result. A file that still fails to load is not finished. The error names the exact key.
