## MODIFIED Requirements

### Requirement: Explicit workflow returns
Top-level `returns:` MUST be either one whole-value template or a non-empty named map of whole-value templates. Return map keys MUST match `[a-z][a-z0-9_]{0,31}`. A whole-value template MUST be allowed to resolve to any supported structured type, including object or array. Literal null and empty maps MUST be rejected. Return expressions MUST reference only results available after all workflow steps. A workflow action MUST produce that declared value as its natural result. Referencing a child action whose target has no `returns:` MUST be a load error. Direct invocation MUST record the declared return in the private per-run snapshot history. Return expressions MUST reject `context.transcript` and `context.transcript_file`, so sensitive capture cannot enter snapshot history through a public result.

#### Scenario: Named child return
- **WHEN** child `inspect` returns `findings: "{{steps.review}}"`
- **THEN** its parent can reference `{{steps.inspection.findings}}`

#### Scenario: Child with no public result
- **WHEN** a parent references a child step whose target omits `returns`
- **THEN** loading fails instead of exposing the child's final or internal step
