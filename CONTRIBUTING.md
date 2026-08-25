# Contributing

Thanks for contributing to herdr-workflows.

## Prerequisites

- [Go](https://go.dev) **1.27** or newer
- [Node.js](https://nodejs.org) **22** or newer with `npm` (VitePress docs only)
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

Herdr runtime docs and schema live in a local checkout. Use `.agents/references/AGENTS.md` to clone and update `.agents/references/herdr`.

## Change classes

Pick the class that matches the change. `go tool verify` remains the gate.

### Risk-class change

The machine is the change. Update the loader, schema, or tests that own the invariant. Add a Hard constraints bullet in `AGENTS.md` only when it is a new agent-facing invariant that a machine already owns. Update the user-facing contract in `docs/` and `README.md` when users see the change.

### Ordinary UI

Put short acceptance criteria in the pull request.

### Skip ritual

Local refactors, tests-only work, and trivial documentation fixes need no extra process beyond the gate.

## Branch and pull requests

1. Create a feature branch. Do not commit to `main`.
2. Keep the change focused.
3. Open a pull request. For ordinary UI, include short acceptance criteria.
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

Pre-commit runs `go tool verify -fast`. CI runs `go tool verify` on Linux and macOS after it installs Node.js, golangci-lint, and GoReleaser. Docs publish uses `npm ci && npm run build` in `docs/`.

## Documentation style

Prose in README, CONTRIBUTING, AGENTS, docs, and tracked skills follows Simplified Technical English form. Use active voice. Use one term per concept. Prefer short sentences. Avoid marketing filler. Do not use semicolons. Use American spelling. Keep exact technical contracts and examples unchanged.
