# Contributing

Thanks for contributing to herdr-workflows.

## Prerequisites

- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) with `npm` (OpenSpec CLI install)
- [herdr](https://herdr.dev) **0.7.5** or newer for live plugin work
- Git

## Local setup

```bash
bun install --frozen-lockfile
```

Optional live link into herdr:

```bash
bun run install:dev
```

Herdr runtime docs and schema live in a local checkout. Follow `.agents/references/AGENTS.md` to clone and update `.agents/references/herdr`.

## OpenSpec

Install the CLI:

```bash
npm install -g @fission-ai/openspec@latest
```

This repository keeps OpenSpec at the canonical root `openspec/`. The official CLI expects that layout. Do not move it.

| Path                                  | Role                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `openspec/config.yaml`                | OpenSpec project config                              |
| `openspec/specs/<capability>/spec.md` | Main specs (current behavior)                        |
| `openspec/changes/<name>/`            | Active change (proposal, design, tasks, delta specs) |

Before you change runtime behavior, read the relevant files under `openspec/specs/*/spec.md`. Cite those specs in your plan or pull request.

A behavior change must create or update an OpenSpec change under `openspec/changes/` before you change code. Do not ship behavior that the main specs and an active change do not cover.

Small prose-only fixes may update docs or specs directly. They do not need a change proposal when no runtime behavior changes.

### Practical workflow

Use the OpenSpec slash commands in your agent harness when available:

1. `/opsx:explore` (optional) — clarify the problem and the affected capabilities.
2. `/opsx:propose` — create the change and fill proposal, design, tasks, and delta specs.
3. Review the artifacts under `openspec/changes/<name>/`.
4. `/opsx:apply` — implement against the tasks and the cited main specs.
5. Run tests and checks (see [Checks](#checks)).
6. `/opsx:archive` — archive the change so delta specs merge into the main specs on the feature branch. Include the archive and main-spec updates in the pull request before merge.

You can drive the same steps with the `openspec` CLI by hand. Keep the root `openspec/` layout.

Validate often:

```bash
openspec validate --all --strict
```

## Branch and pull requests

1. Create a feature branch. Do not commit to `main`.
2. Keep the change focused.
3. Open a pull request. Name every affected capability under `openspec/specs/` in the description.
4. Wait for CI. Fix failures before merge.

## Checks

```bash
bun test ./test
CI=1 npm run verify
bun run docs:build
openspec validate --all --strict
```

Pre-commit runs `CI=1 npm run verify` only. It does not run tests. CI runs tests on Linux and macOS, then verify and the docs build on Linux. `openspec validate` runs locally only.

Local `npm run verify` auto-fixes lint and format. Under `CI=1` it only checks.

## Documentation style

Prose in README, CONTRIBUTING, AGENTS, docs, OpenSpec Markdown, and tracked skills follows Simplified Technical English form. Use active voice. Use one term per concept. Prefer short sentences. Avoid marketing filler. Do not use semicolons. Use American spelling. Keep exact technical contracts and examples unchanged.
