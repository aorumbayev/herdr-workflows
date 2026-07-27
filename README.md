<h3 align="center">
  herdr-workflows
</h3>

<p align="center">Automate stuff in herdr</p>

<p align="center">
  <a href="https://aorumbayev.github.io/herdr-workflows/guide">Guide</a> · <a href="https://aorumbayev.github.io/herdr-workflows/examples">Examples</a> · <a href="https://aorumbayev.github.io/herdr-workflows/reference">Reference</a>
</p>

<p align="center">
  <img src="docs/assets/workbench.png" alt="herdr-workflows web workbench — visual step editor" width="900" />
</p>

---

herdr-workflows is a [herdr](https://herdr.dev) plugin that runs short YAML workflows — sequences of commands (`run:`), coding agents (`agent:`), other workflows (`use:`), and herdr's own pane/worktree methods — from a picker (`prefix+k`), the `hwf` CLI, or a local web workbench. herdr owns panes and UI; this plugin just sequences them.

```yaml
# .hwf/workflows/review.yaml
steps:
  - run: git diff HEAD
    out: diff
  - agent: claude
    when: "{diff}"
    prompt: "Review this diff. Blocking issues only.\n\n{diff}"
```

## Install

You need [herdr](https://herdr.dev) **0.7.5** or newer.

```bash
herdr plugin install aorumbayev/herdr-workflows
```

That compiles the plugin, puts `herdr-workflows` / `hwf` on your PATH, and binds `prefix+k` to the workflow picker.

Then, inside any repo:

```bash
cd your-repo
hwf init            # writes .hwf/config.yaml + a starter `review` workflow
```

Press `prefix+k` to pick and run a workflow, or use the CLI directly:

```bash
hwf run review      # run a workflow, live progress in the terminal
hwf web             # browser workbench: build/edit/validate workflows, browse run log
hwf                 # same as `hwf web`
```

Running always happens through the picker or `hwf run` — it needs real herdr panes, so the web workbench builds and shares but never runs.

## Agent skill

`skills/herdr-workflow-create` is an agent skill that walks you through authoring a workflow, keeps the web workbench canvas drawing it as it goes, and validates the YAML against this plugin's own loader before saving. Paste this to your coding agent and it sets itself up:

```
Install the herdr-workflows toolkit so you can build workflows for me:

1. If `hwf` is not on PATH: herdr plugin install aorumbayev/herdr-workflows
2. Install the skill for this agent:
   npx -y skills add aorumbayev/herdr-workflows --skill herdr-workflow-create -y
3. Read the installed herdr-workflow-create/SKILL.md so you know the authoring workflow.
4. In this repo: run `hwf init` if .hwf/config.yaml is missing, then start the workbench in
   the background with `hwf web --no-open` and give me the URL it prints.
5. Build a small test workflow — one `run: git status --short` step — save it, send me
   <url>#w=repo:<name>, and confirm the canvas draws it. Then interview me for the real one.
```

Or install it by hand:

```bash
npx skills add aorumbayev/herdr-workflows --skill herdr-workflow-create --global
```

## Docs

Full documentation lives at [aorumbayev.github.io/herdr-workflows](https://aorumbayev.github.io/herdr-workflows/) — [Guide](https://aorumbayev.github.io/herdr-workflows/guide) for the concepts, [Examples](https://aorumbayev.github.io/herdr-workflows/examples) for recipes, [Reference](https://aorumbayev.github.io/herdr-workflows/reference) for every rule.

## License

MIT
