# Contributing

Thanks for contributing to herdr-workflows.

## Prerequisites

- [Go](https://go.dev) **1.27** or newer
- [Node.js](https://nodejs.org) **22** or newer with `npm` (VitePress docs and OpenSpec CLI install)
- [golangci-lint](https://golangci-lint.run) **v2.13.1** or newer for full verification and lint in fast verification
- [herdr](https://herdr.dev) **0.8.2** or newer for live plugin work
- Git

## Local setup

```bash
go mod download
```

Optional live link into herdr:

```bash
go run ./scripts/install-dev
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
6. `/opsx:archive` — archive the change so delta specs merge into the main specs on the feature branch. `openspec archive` also moves the change into `openspec/changes/archive/`. Delete that archived content in the same commit — main keeps no archived specs, and `verify:no-archive` fails the pre-commit gate while the folder holds anything. The pull request carries the main-spec updates only.

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

Full verification (same command CI runs on Linux and macOS):

```bash
go tool verify
```

Fast verification for pre-commit:

```bash
go tool verify -fast
```

Test the Go package whose interface you changed.

`go tool verify` fails while `openspec/changes/archive/` holds anything.

Pre-commit runs `go tool verify -fast`. CI runs `go tool verify` on Linux and macOS after it installs Node.js, golangci-lint, GoReleaser, and the OpenSpec CLI. Docs publish uses `npm ci && npm run build` in `docs/`.

## Documentation style

Prose in README, CONTRIBUTING, AGENTS, docs, OpenSpec Markdown, and tracked skills follows Simplified Technical English form. Use active voice. Use one term per concept. Prefer short sentences. Avoid marketing filler. Do not use semicolons. Use American spelling. Keep exact technical contracts and examples unchanged.
