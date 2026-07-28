## ADDED Requirements

### Requirement: Explicit child workflow action
`workflow: <name>` invokes the resolved repository or global workflow at that position in the linear step
list. Repository workflows shadow global workflows of the same name. Unknown targets and direct or
indirect cycles are load errors. The error names the resolution path.

#### Scenario: Child invocation
- **WHEN** a step invokes `workflow: inspect` before a push step
- **THEN** inspect completes before the push starts

#### Scenario: Cycle
- **WHEN** workflow `a` invokes `b` and `b` invokes `a`
- **THEN** loading fails and names the full cycle

### Requirement: Explicit child inputs
A workflow action passes values through its `inputs:` map. When the parent supplies a key, that key must
exactly match an input the child declares. The parent does not need to pass optional inputs. The parent
must supply every required child input. Omitted inputs with defaults use those defaults. Passed values
resolve in the parent's namespaces. Child and recovery workflows never prompt. Every passed value resolves
to text. A text input accepts any text. A static choice requires membership after runtime template
resolution. A dynamic choice runs its argv at child invocation and requires membership before child step
1. A profile input names a merged profile. Load validation checks keys and template source types, but it
does not claim runtime values are known. Objects, arrays, numbers, booleans, and null fail child input
validation.

#### Scenario: Parent value passed
- **WHEN** a parent passes `base: "{{inputs.base}}"` to a child declaring `base`
- **THEN** the child receives the resolved parent input

#### Scenario: Missing required child input
- **WHEN** a required child input has no passed value or default
- **THEN** loading fails before the entry workflow prompts or executes

### Requirement: Isolated child namespace
A child sees only its own inputs and invocation context. It does not see the parent's inputs or step
results, except through explicitly passed input values. Child step IDs stay private.

#### Scenario: Implicit parent access
- **WHEN** a child references a parent step as `{{steps.diff}}`
- **THEN** loading fails because `diff` is not a child step

### Requirement: Explicit workflow returns
Top-level `returns:` is either one whole-value template or a non-empty named map of whole-value
templates. Return map keys must match `[a-z][a-z0-9_]{0,31}`. A whole-value template may resolve to any
supported structured type, including object or array. Literal null and empty maps are rejected. Return
expressions may reference only results available after all workflow steps. A workflow action produces
that declared value as its natural result. Referencing a child action whose target has no `returns:` is a
load error. Direct invocation records the declared return in the run log. Return expressions reject
`context.transcript` and `context.transcript_file`, so sensitive capture cannot enter run-log persistence
through a public result.

#### Scenario: Named child return
- **WHEN** child `inspect` returns `findings: "{{steps.review}}"`
- **THEN** its parent can reference `{{steps.inspection.findings}}`

#### Scenario: Child with no public result
- **WHEN** a parent references a child step whose target omits `returns`
- **THEN** loading fails instead of exposing the child's final or internal step

## REMOVED Requirements

### Requirement: Sub-workflow inclusion via `use:`
**Reason**: Inclusion is replaced by an explicit workflow action and isolated invocation contract.
**Migration**: Replace `use:` with `workflow:`.

### Requirement: Parameterised sub-workflows
**Reason**: `with:` and flat placeholder passing are replaced.
**Migration**: Pass namespaced values through the workflow action's `inputs:` map.

### Requirement: Prompting belongs to the entry workflow
**Reason**: Prompt behavior stays, but recovery and child contracts changed incompatibly.
**Migration**: Declare all picker inputs on the entry workflow and explicitly pass child inputs.

### Requirement: Namespace isolation across inclusion
**Reason**: Leaked child output bindings are replaced by private internals and explicit returns.
**Migration**: Declare child `returns:` and reference the workflow step's natural result.
