## ADDED Requirements

### Requirement: Detached launch encoding failure settles
When a detached `hwf run` launch encodes its private launch payload as JSON and encoding fails, the launcher MUST settle the awaited outcome as failure with the encoding error and MUST NOT write an empty payload to the child stdin.

#### Scenario: Marshal failure does not spawn an empty-payload child
- **WHEN** detached launch payload JSON encoding fails
- **THEN** the awaited handle settles with `OK` false and a detail from that error, and the child does not receive an empty launch payload on stdin
