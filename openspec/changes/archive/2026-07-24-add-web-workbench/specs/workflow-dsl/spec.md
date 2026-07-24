## MODIFIED Requirements

### Requirement: Text-buffer validator entry point
The plugin SHALL expose a single validator, `parseWorkflowText(name, yaml, agents)`, that performs the full workflow load/validate path (parse, flatten, placeholder bans, input checks, agent checks) on an in-memory YAML buffer. The file loader SHALL read the file and delegate to this function so that file-based and buffer-based validation share one code path and produce identical positioned errors.

#### Scenario: Buffer and file validation agree
- **WHEN** the same YAML is validated as an on-disk file and as an in-memory buffer with the same declared agents
- **THEN** both produce the same result and, on failure, the same positioned error message
