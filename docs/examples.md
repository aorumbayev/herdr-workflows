# Examples

Copy into `.hwf/workflows/<name>.yaml`. Agent names come from `.hwf/config.yaml` (or invoking pane via `{agent}`).

Use `{session}` for the agent transcript; `{pane}` when scrollback is enough; `{prompt}` for one focus line; `inputs:` when the user must pick named values (e.g. target agent).

## Handoff (`{session}` + inputs)

Summarize the invoking agent’s transcript, then open a chosen agent with that handoff. Requires `sessions:` (or herdr’s built-in session ref). Seeded by `hwf init` as `handoff`.

```yaml
# .hwf/workflows/handoff.yaml
inputs:
  target:
    options: agents
    label: hand over to
  focus:
    default: ""
steps:
  - shell: claude -p
    stdin: |
      Distil the transcript below into a handoff prompt.
      Output ONLY the handoff prompt.
      ---
      {session}
  - agent: "{input.target}"
    prompt: |
      Focus: {input.focus}

      {last}
```

`prefix+k` → `handoff` → pick target → focus line (prefilled empty). CLI: `hwf run handoff --input target=codex`.

## Worktree space (`options` shell + herdr)

Name a space, pick a **base** branch, create a **new** branch/worktree from that base (avoids “branch already checked out”), rename the root pane to `scratchpad`.

```yaml
# ~/.hwf/workflows/worktree.yaml
inputs:
  name:
    label: space name
  branch:
    label: base branch
    options: "git branch --format='%(refname:short)'"
steps:
  - shell: sh -s
    stdin: |
      set -eu
      NAME='{input.name}'
      BASE='{input.branch}'
      SLUG=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9._-' '-' | sed 's/^-//;s/-$//')
      if [ -z "$SLUG" ]; then
        echo "space name produced empty branch slug" >&2
        exit 1
      fi
      OUT=$(herdr worktree create --branch "$SLUG" --base "$BASE" --label "$NAME" --json --focus)
      PANE=$(printf '%s\n' "$OUT" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); const r=j.result||j; const id=r.root_pane?.pane_id; if(!id){console.error(JSON.stringify(j)); process.exit(1)}; console.log(id)')
      herdr pane rename "$PANE" scratchpad
```

Quote shell metacharacters in `options:` commands (`%(…)` needs quotes — otherwise `sh -c` treats `(…)` as a subshell).
