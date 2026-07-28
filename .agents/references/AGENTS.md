# Herdr reference checkout

This directory holds local checkouts for agent and developer use. Only this file is tracked. Every other path under `.agents/references/` is gitignored.

Herdr runtime behavior for this plugin comes from the checkout at `.agents/references/herdr/`. Read docs, schema, and code there. Do not invent Herdr API behavior from memory.

Pinned docs path for the current plugin floor: `.agents/references/herdr/docs/versions/0.7.5/`.

## Clone when absent

```bash
git clone https://github.com/ogulcancelik/herdr .agents/references/herdr
```

Use that URL only. Do not invent a fork path.

## Before each use

Run these steps from the repository root.

1. Make sure `.agents/references/herdr` exists. Clone it when absent.
2. Fetch origin:

```bash
git -C .agents/references/herdr fetch origin
```

3. Detect the origin default branch. Do not assume `main` or `master`:

```bash
git -C .agents/references/herdr symbolic-ref refs/remotes/origin/HEAD
# example result: refs/remotes/origin/master
```

4. Report local state before any update:

```bash
git -C .agents/references/herdr rev-parse --short HEAD
git -C .agents/references/herdr rev-parse --short origin/<default-branch>
git -C .agents/references/herdr status --short --branch
git -C .agents/references/herdr rev-list --left-right --count HEAD...origin/<default-branch>
```

Report:

- local HEAD
- upstream HEAD on the origin default branch
- ahead and behind counts
- dirty working tree (yes or no)

## Safe update only

Update to the latest upstream default branch only when all of these are true:

- the working tree is clean
- HEAD is not ahead of `origin/<default-branch>` with local commits you must keep
- you intend to move to upstream tip

Then:

```bash
git -C .agents/references/herdr switch --detach origin/<default-branch>
# or, on a local tracking branch with no local commits:
git -C .agents/references/herdr pull --ff-only origin <default-branch>
```

Never overwrite local changes. If the tree is dirty or local commits would be lost, stop and report. Leave the checkout as it is.

## Inspect upstream for breaks

After fetch (and after a safe update when you did one), inspect upstream docs, schema, and code in that checkout. Compare them to this plugin's pinned floor and to `schemas/herdr-api.schema.json`.

Always report upcoming upstream changes that can break herdr-workflows compatibility. Cover at least:

- socket method add, remove, or rename
- param or result shape changes
- pane, agent, layout, or worktree behavior changes
- docs under `docs/versions/` that diverge from the pinned `0.7.5` tree
- protocol or minimum-version changes

If nothing relevant changed, say that clearly.
