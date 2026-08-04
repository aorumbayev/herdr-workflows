# herdr-primitives Specification

## Purpose
Explicit `herdr:` socket actions with generated params and result validation, no autofill targeting, and an accidental-misuse denylist.

## Requirements
### Requirement: Explicit Herdr action
`herdr: <method>` MUST invoke the named Herdr socket RPC method. `params:` MUST contain the request object for that method. Authors MUST omit `params:` or leave it empty only when the method needs no required params. Raw calls MUST mirror the exact Socket API. They MUST NOT infer target params from workflow context. Dotted YAML action keys MUST NOT invoke methods.

#### Scenario: Split pane call
- **WHEN** a step declares `herdr: pane.split` with direction under `params:`
- **THEN** the runner sends that method and params over the Herdr socket

#### Scenario: Unknown method
- **WHEN** `herdr:` names `pane.splitt`
- **THEN** loading fails and names the unknown Herdr method

### Requirement: Typed Herdr params templates
Strings inside `params:` MUST support v1alpha1 templates recursively. A whole-value template MUST preserve objects, arrays, numbers, booleans, and null. Embedded templates MUST render as text. Substitution MUST stay structured and MUST never create shell source.

#### Scenario: Exact pane identifier
- **WHEN** `pane_id` is `{{steps.create.pane_id}}`
- **THEN** the exact identifier is sent as the string param

### Requirement: Generated request and result validation
The loader MUST generate method existence, params, protocol number, and success-result checks from the vendored Herdr API schema. Loading MUST reject unknown params, wrong types, and missing required params. Before input collection or execution, startup MUST reject a live Herdr version below the plugin manifest minimum or a protocol mismatch. The rejection MUST name the installed and required versions and both protocols. Socket calls MUST address the Unix domain socket Herdr serves at `HERDR_SOCKET_PATH`. A transport failure MUST name the unreachable Herdr and the resolved address, and MUST be distinguishable from a version rejection, a protocol rejection, and a workflow authoring error. Workflow YAML MUST NOT duplicate a Herdr version requirement. A successful action MUST keep the complete structured result as its natural step result.

#### Scenario: Wrong param type
- **WHEN** `pane.split` receives text for numeric `ratio`
- **THEN** loading fails with a generated type error

#### Scenario: Structured result reference
- **WHEN** `worktree.create` succeeds under step ID `tree`
- **THEN** a later step may reference a schema-valid field such as `{{steps.tree.worktree.path}}`

#### Scenario: Variant-specific result path
- **WHEN** a referenced path exists in at least one generated success variant but not the result received
- **THEN** the action fails at runtime and names the actual result variant and missing path

#### Scenario: Preflight reaches Herdr on every supported platform
- **WHEN** a live compatible Herdr is listening and a workflow starts on macOS or Linux
- **THEN** preflight succeeds and execution proceeds to the first step

#### Scenario: Transport failure is named as such
- **WHEN** the configured socket address cannot be reached
- **THEN** the failure identifies an unreachable Herdr and the resolved address rather than a version mismatch or a workflow error

### Requirement: Explicit raw method targets
Authors MUST supply every required or behavior-selecting target under `params:`, using the method's exact schema field. Authors MUST use canonical context explicitly when they want it. The loader MUST validate mutually exclusive selectors through generated or cross-field rules. It MUST never let an omitted raw target fall through to mutable Herdr UI focus.

The loader MUST reject any allowed `herdr:` call that omits a schema parameter Herdr would otherwise resolve from live UI state. That required-selector set MUST be derived from the generated schema so a regenerated method is rejected until policy classifies it. An unclassified allowed method MUST NOT load. Genuine list/filter scopes MAY omit their scope selectors when policy explicitly opts them out.

Non-normative illustration for pinned Herdr 0.8.0 (derived output, not the completeness guarantee): `tab.create` requires `workspace_id`; `pane.split` requires `target_pane_id`; `pane.swap` requires its direction+`pane_id` form or both source/target IDs; `layout.apply` and `layout.set_split_ratio` require exactly one of their paired selectors; `worktree.list` / `create` / `open` require exactly one of `workspace_id` or `cwd`; `pane.list` and `tab.list` keep optional filter scopes.

#### Scenario: Invocation tab rename
- **WHEN** a workflow intends to rename its invocation tab
- **THEN** it supplies `tab_id: "{{context.tab}}"` explicitly

#### Scenario: Explicit split target
- **WHEN** a raw `pane.split` omits `target_pane_id`
- **THEN** loading fails rather than allowing Herdr to choose the focused pane

### Requirement: Denied methods
The loader MUST deny every `server.*` and `plugin.*` method, `events.subscribe`, `session.snapshot`, `popup.close`, every `pane.graphics.*` method, `pane.report_agent`, `pane.report_agent_session`, `pane.clear_agent_authority`, `pane.release_agent`, `agent.view.set`, and `agent.view.clear`. Each denial MUST state the authoring or runtime invariant it protects. The loader MUST allow other generated methods only when their namespace is `workspace.*`, `tab.*`, `pane.*`, `worktree.*`, `agent.*`, or `layout.*`, or the exact method is `notification.show`, the `client.window_title.*` prefix, or `ping`. The loader MUST deny a newly generated method outside those areas by default until policy explicitly admits it. Documentation MUST call this an accidental-misuse safety rail, not security. Trusted `run:` actions can invoke the complete Herdr CLI or socket directly.

#### Scenario: Server shutdown denied
- **WHEN** a workflow declares `herdr: server.stop`
- **THEN** loading fails because the method would stop the server running the workflow
