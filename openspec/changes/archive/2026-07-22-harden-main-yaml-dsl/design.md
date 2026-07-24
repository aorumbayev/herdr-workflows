## Context

Main keeps linear YAML (`shell|open|agent|herdr`) + herdr panes. Harden seeds and DSL: session-based handoff, worktree ritual, agent `close_source`, `HWF_INPUT_*` for shell CLIs.

## Goals / Non-Goals

**Goals:**

- Harden DSL docs + seeds: session-first handoff, worktree seed.
- Export workflow `inputs` to shell as `HWF_INPUT_<name>` env (argv-safe; no placeholder-in-command).
- Optional `close_source: true` on `agent:` steps.

**Non-Goals:**

- External workflow engines, dual runtimes, or shell task-runner sidecars as product surface.
- Parallel deps, retries-as-engine, durable run store.
- Allowing `{input.*}` interpolation into `shell:`/`open:` command text.

## Decisions

1. **Herdr YAML remains sole runtime** for picker / `hwf run`.
2. **Session-first handoff seed** — `{session}` via `stdin` on `shell: cat`, then distill agent, then target agent.
3. **`HWF_INPUT_*` env for shell** — worktree/other CLI argv builds read env, not template-into-command.
4. **`close_source` on agent** — after successful `layout.apply`, close invoking `tabId`.

## Risks / Trade-offs

- [Session empty / unsupported agent] → seed documents `sessions:` + Claude built-in; fail loudly via existing session errors.
- [HWF_INPUT env collision] → prefix `HWF_INPUT_`; only declared inputs.
- [close_source loses tab on later step fail] → only close after successful open; document irreversibility.

## Migration Plan

1. Land on `harden-main-yaml-dsl`.
2. Users: `hwf init` (or copy examples) for new seeds.
3. Rollback: revert PR; no data migration.

## Open Questions

- None blocking — `herdr worktree create` CLI assumed available.
