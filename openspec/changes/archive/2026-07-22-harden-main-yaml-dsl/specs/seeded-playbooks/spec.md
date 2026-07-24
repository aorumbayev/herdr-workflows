## ADDED Requirements

### Requirement: Session-first handoff seed
`hwf init` SHALL seed a `handoff` workflow that distils the invoking agent session transcript (via `{session}` in `stdin` to a headless LLM `shell` step) and opens a user-selected target agent with the distilled prompt plus optional focus input.

#### Scenario: Init writes handoff
- **WHEN** `hwf init` runs in a repo with at least one detected agent
- **THEN** `.hwf/workflows/handoff.yaml` is created (unless it already exists) using session-based distill and `inputs.target` with `options: agents`

### Requirement: Worktree seed
`hwf init` SHALL seed a `worktree` workflow that collects `branch` and `base` inputs and runs `herdr worktree create` via `shell` using `HWF_INPUT_*` environment variables (no placeholders in the command string).

#### Scenario: Init writes worktree
- **WHEN** `hwf init` runs with a detected agent present (seeds gated as today)
- **THEN** `.hwf/workflows/worktree.yaml` is created unless it already exists

### Requirement: Review seed retained
`hwf init` SHALL continue to seed `review` as a git-diff → agent review playbook.

#### Scenario: Review still seeded
- **WHEN** `hwf init` writes workflow seeds
- **THEN** `review` is among the seeded names when an agent was detected
