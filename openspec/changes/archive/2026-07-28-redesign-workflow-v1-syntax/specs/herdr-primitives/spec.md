## ADDED Requirements

### Requirement: Explicit Herdr action
`herdr: <method>` must invoke the named Herdr socket RPC method. `params:` must contain the request
object for that method. Authors omit `params:` or leave it empty only when the method needs no required
params. Raw calls must mirror the exact Socket API. They must not infer target params from workflow
context. Dotted YAML action keys must not invoke methods.

#### Scenario: Split pane call
- **WHEN** a step declares `herdr: pane.split` with direction under `params:`
- **THEN** the runner sends that method and params over the Herdr socket

#### Scenario: Unknown method
- **WHEN** `herdr:` names `pane.splitt`
- **THEN** loading fails and names the unknown Herdr method

### Requirement: Typed Herdr params templates
Strings inside `params:` support v1alpha1 templates recursively. A whole-value template preserves
objects, arrays, numbers, booleans, and null. Embedded templates render as text. Substitution stays
structured and never creates shell source.

#### Scenario: Exact pane identifier
- **WHEN** `pane_id` is `{{steps.create.pane_id}}`
- **THEN** the exact identifier is sent as the string param

### Requirement: Generated request and result validation
The loader generates method existence, params, protocol number, and success-result checks from the
vendored Herdr API schema. Loading rejects unknown params, wrong types, and missing required params.
Before input collection or execution, startup rejects a live Herdr version below the plugin manifest
minimum or a protocol mismatch. The rejection names the installed and required versions and both
protocols. Workflow YAML must not duplicate a Herdr version requirement. A successful action keeps the
complete structured result as its natural step result.

#### Scenario: Wrong param type
- **WHEN** `pane.split` receives text for numeric `ratio`
- **THEN** loading fails with a generated type error

#### Scenario: Structured result reference
- **WHEN** `worktree.create` succeeds under step ID `tree`
- **THEN** a later step may reference a schema-valid field such as `{{steps.tree.worktree.path}}`

#### Scenario: Variant-specific result path
- **WHEN** a referenced path exists in at least one generated success variant but not the result received
- **THEN** the action fails at runtime and names the actual result variant and missing path

### Requirement: Explicit raw method targets
Authors must supply every required or behavior-selecting target under `params:`, using the method's
exact schema field. Authors use canonical context explicitly when they want it. The loader validates
mutually exclusive selectors through generated or cross-field rules. It never lets an omitted raw target
fall through to mutable Herdr UI focus.

For pinned Herdr 0.7.5, the explicit-focus policy requires: `tab.create.workspace_id`;
`pane.current.caller_pane_id`; `pane.layout.pane_id`; `pane.process_info.pane_id`;
`pane.neighbor.pane_id`; `pane.edges.pane_id`; `pane.focus_direction.pane_id`;
`pane.resize.pane_id`; `pane.zoom.pane_id`; `pane.split.target_pane_id`; `pane.swap.pane_id` for its
direction form or both source/target IDs for its pair form; `pane.move.destination.target_pane_id` for a
tab split and destination workspace for new-tab placement; one of `layout.apply.workspace_id` or
`layout.apply.tab_id`; and one of `layout.export.pane_id` or `layout.export.tab_id`. Optional list/filter
scopes such as `pane.list.workspace_id` and `tab.list.workspace_id` stay optional. Each of
`worktree.list`, `worktree.create`, and `worktree.open` requires exactly one of `workspace_id` or `cwd`.
`layout.set_split_ratio` requires exactly one of `tab_id` or `pane_id`. Updating the pinned Herdr schema
requires reviewing and updating this policy table.

#### Scenario: Invocation tab rename
- **WHEN** a workflow intends to rename its invocation tab
- **THEN** it supplies `tab_id: "{{context.tab}}"` explicitly

#### Scenario: Explicit split target
- **WHEN** a raw `pane.split` omits `target_pane_id`
- **THEN** loading fails rather than allowing Herdr to choose the focused pane

### Requirement: Denied methods
The loader denies every `server.*` and `plugin.*` method, `events.subscribe`, `session.snapshot`,
`popup.close`, every `pane.graphics.*` method, `pane.report_agent`, `pane.report_agent_session`,
`pane.clear_agent_authority`, `pane.release_agent`, `agent.view.set`, and `agent.view.clear`. Each denial
states the authoring or runtime invariant it protects. The loader allows other generated methods only
when their namespace is `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`, or `layout.*`, or the
exact method is `notification.show`, the `client.window_title.*` prefix, or `ping`. The loader denies a
newly generated method outside those areas by default until policy explicitly admits it. Documentation
must call this an accidental-misuse safety rail, not security: trusted `run:` actions can invoke the
complete Herdr CLI or socket directly.

#### Scenario: Server shutdown denied
- **WHEN** a workflow declares `herdr: server.stop`
- **THEN** loading fails because the method would stop the server running the workflow

## REMOVED Requirements

### Requirement: Dotted method steps
**Reason**: Arbitrary dotted keys hid provenance and complicated action-key validation.
**Migration**: Use `herdr: <method>` with separate `params:`.

### Requirement: Params are interpolated, not shell text
**Reason**: Interpolation now uses explicit namespaces and typed whole-value behavior.
**Migration**: Replace flat placeholders with v1alpha1 templates under `params:`.

### Requirement: Caller context autofill
**Reason**: Generic or method-specific implicit targeting could select mutable UI focus or violate selector combinations.
**Migration**: Supply exact Socket API target params using `context` or prior results.

### Requirement: Generated param validation
**Reason**: Request and result validation combine under the automatic result model.
**Migration**: No behavioral migration beyond v1alpha1 action syntax.

### Requirement: Protocol pinning
**Reason**: Protocol pinning stays as part of generated validation rather than a separate grammar rule.
**Migration**: None for authors.

### Requirement: Result dot-path binding
**Reason**: `out:` bindings are replaced by automatic structured step results.
**Migration**: Give the action an ID and reference `{{steps.<id>.<field>}}`.
