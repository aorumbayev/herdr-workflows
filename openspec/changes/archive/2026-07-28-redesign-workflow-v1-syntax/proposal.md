## Why

The current experimental grammar had accumulated terse aliases, overloaded keys, a flat value namespace,
and workflow-engine features that obscured the product's purpose: automating small, supervised Herdr
rituals. Before the alpha format gained external stability expectations, this change replaced it with one
coherent, portable `v1alpha1` contract designed around attention-saving linear workflows.

## What Changes

- **BREAKING** Replace the entire existing workflow grammar with explicit format `version: v1alpha1`.
  Remove all compatibility parsing, legacy aliases, migration diagnostics, and support for prior
  experimental variants.
- Make `agent:` a managed Herdr agent turn: `using:` starts a native recognized kind, while `target:`
  addresses an existing recognized agent. Both preserve native lifecycle metadata and capture a
  plugin-managed response file.
- Replace dotted action keys with four explicit actions: `agent`, `run`, `herdr`, and `workflow`.
- Replace flat `{name}` interpolation and explicit `out:` bindings with `{{inputs.*}}`, `{{steps.*}}`, and
  `{{context.*}}` namespaces plus automatic natural step results.
- Keep execution linear. Retain conditions, tolerated failures, constrained retries, and one recovery
  action. Remove loops, parallel branches, joins, and general retry reset machinery.
- Group stable, invocation-anchored placement under `pane:`, with `open: tab|beside|below`, percentage
  `size`, focus, and explicit `close: success|always`. Keep execution controls such as `background` and
  thin native `ready_when` outside that block.
- Give child workflows private internals and explicit `returns:` contracts.
- Replace agent command configuration with shareable Herdr-kind profiles, optional startup args, renamed
  transcript extractors, Herdr's plugin config directory, and a gitignored project-local override layer.
- Preserve argv execution as the portable, interpolation-safe command form. Shell strings stay explicit,
  platform-specific, and reject templates.
- Treat workflows as reviewed executable code, and treat the Herdr method denylist as an
  accidental-misuse safety rail, not a sandbox or authorization boundary.

## Capabilities

### New Capabilities
- `profile-configuration`: Shareable role-oriented native Herdr agent profiles, adaptive profile inputs,
  transcript extraction, plugin-owned global config, and machine-local overrides.

### Modified Capabilities
- `workflow-grammar`: Replaces top-level shape, actions, inputs, templates, results, placement, process
  lifecycle, metadata, and format versioning with the v1 contract.
- `workflow-composition`: Replaces step inclusion and leaked bindings with isolated child invocation,
  explicit inputs, and explicit returns.
- `step-control-flow`: Reduces control flow to linear conditions, tolerated failures, constrained
  retries, and one-action failure recovery.
- `herdr-primitives`: Replaces dotted method action keys and output bindings with explicit `herdr:`
  calls, `params:`, and automatic structured results.

## Impact

This change touched the parser, workflow types, loader, runner, profile configuration, picker, web
workbench, JSON Schema, examples, documentation, and tests. Every existing workflow and every legacy
`agents:` command configuration needed a rewrite. `sessions:` extraction configuration was renamed to
`transcripts:`. The implementation intentionally provides no workflow or configuration compatibility
layer. Herdr's plugin manifest and CLI own minimum Herdr version enforcement; workflow YAML declares only
its format version. Herdr protocol validation, method safety rails, pane execution, transcript capture,
and run logging remain underlying runtime services.
