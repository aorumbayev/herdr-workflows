# workflow-composition Specification

## Purpose
Explicit child `workflow:` invocation with isolated namespaces, typed inputs, and declared returns.

## Requirements
### Requirement: Explicit child workflow action
`workflow: <name>` MUST invoke the resolved repository or global workflow at that position in the linear step list. Repository workflows MUST shadow global workflows of the same name. Unknown targets and direct or indirect cycles MUST be load errors. The error MUST name the resolution path.

#### Scenario: Child invocation
- **WHEN** a step invokes `workflow: inspect` before a push step
- **THEN** inspect completes before the push starts

#### Scenario: Cycle
- **WHEN** workflow `a` invokes `b` and `b` invokes `a`
- **THEN** loading fails and names the full cycle

### Requirement: Frozen child graph per execution process
After the entry workflow loads, every `workflow:` step and recovery workflow action in that process MUST execute the complete child graph that load resolved and validated with the entry. Repeated and recursive child calls MUST reuse those retained definitions. Mid-run edits to child workflow files on disk MUST affect only a later load, not the active run. Dynamic child input choices MUST still resolve per child invocation. The retained graph MUST NOT be serialized into launch payloads or run history.

#### Scenario: Mid-run child file edit
- **WHEN** an entry workflow invokes the same child twice and the child's YAML file changes on disk between those invocations
- **THEN** both invocations execute the child definition resolved at entry load

#### Scenario: Recursive retained children
- **WHEN** a retained child itself invokes another workflow
- **THEN** that nested child also comes from the graph validated with the entry load

### Requirement: Explicit child inputs
A workflow action MUST pass values through its `inputs:` map. When the parent supplies a key, that key MUST exactly match an input the child declares. The parent MUST NOT need to pass optional inputs. The parent MUST supply every required child input. Omitted inputs with defaults MUST use those defaults. Passed values MUST resolve in the parent's namespaces. Child and recovery workflows MUST never prompt. Every passed value MUST resolve to text. A text input MUST accept any text. A static choice MUST require membership after runtime template resolution. A dynamic choice MUST run its argv at child invocation and require membership before child step 1. A profile input MUST name a merged profile. Load validation MUST check keys and template source types, but it MUST NOT claim runtime values are known. Objects, arrays, numbers, booleans, and null MUST fail child input validation.

#### Scenario: Parent value passed
- **WHEN** a parent passes `base: "{{inputs.base}}"` to a child declaring `base`
- **THEN** the child receives the resolved parent input

#### Scenario: Missing required child input
- **WHEN** a required child input has no passed value or default
- **THEN** loading fails before the entry workflow prompts or executes

### Requirement: Isolated child namespace
A child MUST see only its own inputs and invocation context. It MUST NOT see the parent's inputs or step results, except through explicitly passed input values. Child step IDs MUST stay private.

#### Scenario: Implicit parent access
- **WHEN** a child references a parent step as `{{steps.diff}}`
- **THEN** loading fails because `diff` is not a child step

### Requirement: Explicit workflow returns
Top-level `returns:` MUST be either one whole-value template or a non-empty named map of whole-value templates. Return map keys MUST match `[a-z][a-z0-9_]{0,31}`. A whole-value template MUST be allowed to resolve to any supported structured type, including object or array. Literal null and empty maps MUST be rejected. Return expressions MUST reference only results available after all workflow steps. A workflow action MUST produce that declared value as its natural result. Referencing a child action whose target has no `returns:` MUST be a load error. Direct invocation MUST record the declared return in the private per-run snapshot history. Return expressions MUST reject `context.transcript` and `context.transcript_file`, so sensitive capture cannot enter snapshot history through a public result.

#### Scenario: Named child return
- **WHEN** child `inspect` returns `findings: "{{steps.review}}"`
- **THEN** its parent can reference `{{steps.inspection.findings}}`

#### Scenario: Child with no public result
- **WHEN** a parent references a child step whose target omits `returns`
- **THEN** loading fails instead of exposing the child's final or internal step
