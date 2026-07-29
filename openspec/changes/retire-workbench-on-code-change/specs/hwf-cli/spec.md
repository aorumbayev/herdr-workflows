## ADDED Requirements

### Requirement: Owned workbench retires on code change
An owned workbench process MUST stop when the code it was built from changes, in addition to stopping on termination signals. A compiled install MUST watch its own executable, because a plugin upgrade replaces or relocates the managed checkout that holds it. A run from an on-disk script entry MUST watch that entry's source tree instead, because the executable is then the runtime rather than the plugin build, and MUST react only to source files the workbench serves. Retirement MUST use the same shutdown path as termination signals, so the endpoint record is released. An unwatchable target MUST NOT fail the command or prevent signal shutdown.

#### Scenario: Plugin upgrade replaces the executable
- **WHEN** the executable of an owned compiled workbench is replaced or its containing checkout is moved
- **THEN** that workbench stops and releases its endpoint record, so the next workbench action starts a server from the new build

#### Scenario: Development source change
- **WHEN** an owned workbench was started from an on-disk script entry and a served source file under that entry's tree changes
- **THEN** that workbench stops and releases its endpoint record

#### Scenario: Unwatchable target
- **WHEN** the resolved watch target cannot be watched
- **THEN** the workbench keeps serving and still stops on termination signals
