## MODIFIED Requirements

### Requirement: Portable and shell run forms
`run:` MUST accept a non-empty string or non-empty string list. List form MUST execute directly as argv on every supported platform and MUST allow templates per element. String form MUST execute as shell source, MUST reject templates, and MUST accept `shell:` values `sh`, `bash`, `zsh`, `pwsh`, `powershell`, and `cmd`. The Windows shell values remain valid workflow syntax for format compatibility, but native Windows execution is unsupported. Omitted shell MUST mean `sh` on supported macOS and Linux hosts. Each input MUST be exported as `HWF_<name>`. Prior results MUST enter shell environments only through explicit `env:` mappings. Runner-generated values MUST replace inherited collisions. Explicit env keys MUST reject reserved `HWF_` prefixes case-insensitively. The generated HWF environment block MUST have a 24 KiB cap. Captured command stdout plus stderr, managed agent response, transcript text, and dynamic-choice stdout MUST each have an 8 MiB cap. Crossing a cap MUST fail the step, naming the source and byte limit, rather than truncating output. Streaming commands MUST be terminated when their capture crosses the limit, and termination MUST stop the process actually producing the output, not only the shell that launched it.

`shell` MUST be invalid on argv. `cwd` MUST be template-capable text. `env` MUST be a string map with template-capable values merged over inherited environment after reserved-key checks. Timeout on a local blocking run MUST terminate the command and its descendants and fail the step, using the host platform's mechanism for terminating a process tree. Timeout MUST be invalid on background. Omitted local-run `cwd` MUST use workflow invocation cwd. Omitted local-run timeout MUST mean no workflow timeout, though process completion still blocks the step.

#### Scenario: Portable argument
- **WHEN** argv contains a branch value with spaces
- **THEN** it reaches the process as one argument without a shell

#### Scenario: Unsafe shell interpolation
- **WHEN** shell source contains a workflow template
- **THEN** loading fails and directs the author to argv or explicit environment values

#### Scenario: Timeout stops a shell grandchild
- **WHEN** a string `run:` launches a long-running command through the platform shell and the step timeout expires
- **THEN** the launched command is no longer running and the step fails naming the deadline

#### Scenario: Cap termination stops the producer
- **WHEN** a string `run:` launches a command that streams past the capture cap
- **THEN** the producing command is terminated, the step fails naming the source and byte limit, and no output is truncated in place of failing
