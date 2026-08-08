# workflow-grammar Specification

## Purpose
v1alpha1 workflow document shape, four actions, namespaced templates, natural results, placement, and invocation context.
## Requirements
### Requirement: Alpha-versioned workflow document
A workflow MUST declare string `version: v1alpha1` and a non-empty `steps:` list. The document MUST accept only `version`, `title`, `description`, `hidden`, `inputs`, `returns`, `on_failure`, and `steps` at top level. The parser MUST support no other format version. A later incompatible alpha format MUST use a new `v1alphaN` value.

#### Scenario: Minimal alpha document
- **WHEN** a file contains `version: v1alpha1` and one step
- **THEN** the sole v1alpha1 parser loads it

#### Scenario: Unsupported alpha revision
- **WHEN** a file declares another format version
- **THEN** loading fails with the supported format and rewrite-or-upgrade guidance

### Requirement: Four explicit actions and strict modifiers
Every step MUST carry exactly one action from `agent`, `run`, `herdr`, and `workflow`. Every step MUST accept optional `id`, `when`, and `continue_on_error`. Agent actions MUST also accept mutually exclusive `using` and `target`, plus `cwd`, `env`, `pane`, `background`, `timeout`, and `expect`. Run actions MUST also accept `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`, and `success_codes`. Herdr actions MUST also accept `params` and `retry`. Workflow actions MUST also accept `inputs`. Any other key MUST be a load error. Dotted keys MUST never be inferred as actions. Keys such as `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, and `as` MUST fail as unknown keys.

#### Scenario: Multiple actions
- **WHEN** a step contains both `run` and `agent`
- **THEN** loading fails and names both actions

#### Scenario: Unknown step key
- **WHEN** a step declares `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, or `as`
- **THEN** loading fails with an ordinary unknown-key error

### Requirement: Explicit workflow template namespaces
Workflow templates MUST use `{{path}}` rooted at `inputs`, `steps`, or `context`. The configuration-only `{{prompt}}` sentinel MUST NOT be a workflow template. Step IDs MUST match `[a-z][a-z0-9_]{0,31}` and stay optional unless referenced. The loader MUST reject duplicate IDs, unknown paths, forward references, and references to background, skipped, or otherwise result-less steps.

#### Scenario: Prior result
- **WHEN** a prompt references `{{steps.assess.response}}` from an earlier step ID
- **THEN** the resolved managed response is inserted

#### Scenario: Live focus is not context
- **WHEN** the user focuses another pane while a workflow runs
- **THEN** `{{context.pane}}` remains the pane captured at invocation

### Requirement: Typed template evaluation
A whole-value template in structured YAML MUST preserve the source type. Embedded templates MUST render strings unchanged, booleans as lowercase text, finite numbers in decimal form, null as empty text, and arrays or objects as compact JSON. Agent prompts MUST always render to text.

#### Scenario: Structured RPC param
- **WHEN** a complete params value references a result object
- **THEN** the object remains structured rather than becoming JSON text

### Requirement: Natural step results
A blocking managed agent turn MUST produce `{response, agent, pane_id}`, where `response` and `pane_id` are strings and `agent` is native Herdr AgentInfo. A blocking managed agent turn that declares `expect` MUST also produce string `verdict`. A local command MUST produce string `stdout`, string `stderr`, integer `exit_code`, and boolean `failed`. A placed command that satisfies readiness MUST produce the complete native wait result, plus created pane/tab/workspace identifiers. A Herdr action MUST produce its complete native success result. A child workflow MUST produce its declared returns. Background and skipped steps MUST produce no result. V1alpha1 MUST NOT support `out` or positional `previous`.

#### Scenario: Managed agent response
- **WHEN** a blocking agent settles and writes non-empty managed output
- **THEN** later steps can read `{{steps.review.response}}` and native agent metadata

#### Scenario: Missing managed output
- **WHEN** Herdr reports settlement but the managed response file is missing or empty
- **THEN** the agent step fails

### Requirement: Portable and shell run forms
`run:` MUST accept a non-empty string or non-empty string list. List form MUST execute directly as argv on every supported platform and MUST allow templates per element. String form MUST execute as shell source, MUST reject templates, and MUST accept `shell:` values `sh`, `bash`, `zsh`, `pwsh`, `powershell`, and `cmd`. The Windows shell values remain valid workflow syntax for format compatibility, but native Windows execution is unsupported. Omitted shell MUST mean `sh` on supported macOS and Linux hosts. Each input MUST be exported as `HWF_<name>`. Prior results MUST enter shell environments only through explicit `env:` mappings. Runner-generated values MUST replace inherited collisions. Explicit env keys MUST reject reserved `HWF_` prefixes case-insensitively. The generated HWF environment block MUST have a 24 KiB cap. Captured command stdout plus stderr, managed agent response, transcript text, and dynamic-choice stdout MUST each have an 8 MiB cap. Crossing a cap MUST fail the step, naming the source and byte limit, rather than truncating output. Streaming commands MUST be terminated when their capture crosses the limit, and termination MUST stop the process producing the output, not only the shell that launched it.

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

### Requirement: Named adaptive inputs
Input names MUST match `[a-z][a-z0-9_]{0,31}`. Values MUST be `text`, `profile`, a non-empty static choice list, or a strict map containing only `type`, `description`, `default`, `when`, `allow_custom`, `min_length`, and, conditionally, `options`. Map type MUST be `text`, `choice`, or `profile`. Choice MUST require static options or `{run: <argv>}`. Text and profile MUST reject options. Dynamic choice failure or empty output MUST fail collection. Choice and profile defaults MUST exist in the available values. Only the entry workflow MUST prompt, in declaration order, and unused inputs MUST fail load.

Dynamic choice argv elements MAY contain templates rooted at `inputs` that reference earlier declared inputs. Templates rooted at `steps` or `context` inside dynamic argv MUST be load errors. A self reference or forward reference MUST be a load error. Referencing a conditional input MUST be a load error unless the consuming input's `when:` carries every clause that guards the referenced input. The runner MUST substitute referenced values into argv elements before execution. Dynamic choice argv MUST run from repository root with the invoking environment and MUST receive no partially collected input exports. Nonzero exit MUST fail the step with capped stderr. Stdout MUST split on LF/CRLF, trim surrounding whitespace, discard empty lines, and deduplicate while preserving first-seen order. More than 1,000 choices, or crossing the shared capture cap, MUST fail input collection. Dynamic choice commands MUST time out after 10 seconds and get terminated as a process group.

#### Scenario: Profile picker
- **WHEN** an input has type profile
- **THEN** the picker lists merged native-kind profile names in deterministic order

#### Scenario: Cascading dynamic choice
- **WHEN** input `repo` is a dynamic choice and input `branch` declares `{run: [git, -C, "{{inputs.repo}}", branch, --format, "%(refname:short)"]}`
- **THEN** the `branch` options resolve after `repo` is answered, with the answered value substituted into the argv element

#### Scenario: Forward reference in dynamic argv
- **WHEN** an earlier input's dynamic argv references a later input
- **THEN** loading fails naming the forward reference

#### Scenario: Unguarded reference to a conditional input
- **WHEN** input `branch` references `{{inputs.remote}}` in its dynamic argv, `remote` is guarded by `mode == "push"`, and `branch` declares no matching guard
- **THEN** loading fails naming the missing guard clause

### Requirement: Managed native agent action
`agent:` MUST contain non-empty prompt text. `using:` MUST resolve a merged profile. When both `using` and `target` are absent, the runner MUST use the merged `default_profile`. New-agent mode MUST create a requested or default Herdr pane, call native `agent.start` with profile kind/args, and submit through `agent.prompt`. `target:` MUST resolve an existing agent name or pane ID. It MUST reject `pane`, `cwd`, and `env`, and MUST submit through `agent.prompt` without launching a new agent. Blocking turns MUST append the managed response-file instruction and wait for `idle` or `done`. `blocked` MUST send one notification per blocked episode and keep waiting. `unknown` MUST never count as successful settlement. Omitted timeout MUST default to 30 minutes and apply to the prompted turn. Native agent interactive readiness MUST use a separate 30-second startup deadline.

Before target-mode submission, the runner MUST require the existing agent to be `idle` or `done`. `working`, `blocked`, and `unknown` MUST fail before prompt submission, because Herdr does not correlate individual turns. New-agent mode MUST generate the required live name as a normalized step ID or `step-<ordinal>` prefix, plus a per-run collision-resistant suffix, truncated to 32 characters while matching `[a-z][a-z0-9_-]{0,31}`.

The settled-target check MUST be advisory against obvious misuse, not the response correlation token. Another caller can race it, because Herdr has no atomic expected-state or turn ID. The unique managed response path MUST correlate completion. After prompt submission, the runner MUST keep observing until that exact non-empty file exists and the target is idle or done, even if native prompt waiting returns for another turn first. Timeout MUST fail the step without accepting another turn's lifecycle as this result.

#### Scenario: Native profile turn
- **WHEN** a step uses profile `deep-review` backed by kind `claude`
- **THEN** Herdr starts Claude in the created shell pane, detects readiness, submits the prompt, and the plugin captures combined output

#### Scenario: Existing target turn
- **WHEN** `target` names the invoking recognized agent
- **THEN** no pane is created and the managed prompt is sent only when that live agent is idle or done

#### Scenario: Busy existing target
- **WHEN** target mode resolves a working or blocked agent
- **THEN** the step fails before submission and points to raw `herdr: agent.prompt` for intentional queueing

#### Scenario: Background turn
- **WHEN** an agent uses `background: true`
- **THEN** start and prompt submission complete before the workflow continues, but no result is captured

### Requirement: Stable pane placement
`agent` and `run` MUST accept a `pane:` block containing only `open`, `target`, `workspace`, `size`, `focus`, and `close`. `open` MUST be `tab`, `beside`, or `below`. `beside` and `below` MUST accept only `target`, default it to invocation `context.pane`, and map to Herdr right/down splits. `tab` MUST accept only `workspace` and default it to invocation `context.workspace`. `size` MUST be an integer percentage from 1 through 99 for splits, and MUST allocate that amount to the new pane. Foreground panes MUST focus by default. Background panes MUST NOT. Placement MUST use explicit captured IDs and never current UI focus.

`close` MUST apply only to newly created managed agent panes and MUST be `success` or `always`. Omitting `close` MUST keep the pane. `success` MUST close the pane only after successful settlement and response capture. `always` MUST close the pane after any terminal outcome once a pane exists. Since Herdr 0.8.0, closing the pane that hosts a workspace's last tab closes that workspace. The runner MUST NOT guard against this and MUST keep the step outcome unchanged. Background actions MUST reject `close`. The `pane:` block MUST require `open`. New-agent mode that omits the complete block MUST create a new tab in the invocation workspace, with foreground/background focus defaults unchanged. Run actions MUST reject `pane.close`, because readiness/background runs have no terminal cleanup point.

#### Scenario: Stable split
- **WHEN** the user changes UI focus before an omitted-target `beside` step
- **THEN** the runner splits the invocation pane through explicit `target_pane_id`

#### Scenario: Failed agent with success cleanup
- **WHEN** an agent with `close: success` times out
- **THEN** its pane remains visible for diagnosis

### Requirement: Herdr-owned background and readiness
`background: true` MUST require a newly created `pane:`, except when `target:` already addresses an existing Herdr agent pane. It MUST be mutually exclusive with `ready_when`, timeout, and pane cleanup. Local detached background MUST NOT exist. Pane-owned background processes MUST survive client detach but not ordinary server restart. The runner MUST never stop them implicitly after a later workflow failure.

A placed run MUST require exactly one of background or `ready_when: /regex/`. Readiness MUST require timeout and MUST delegate to native `pane.wait_for_output` with `source: "recent"`, `strip_ansi: true`, and one logical-line Rust regex match. The recent-line window size is a tuning constant, not a conformance requirement. Readiness MUST report success exactly when the pattern has matched since the pane was created, and MUST fail only when the deadline passes with no match. It MUST succeed only on native match. Existing snapshot text MAY match. The workflow layer MUST NOT promise process-exit detection. The regex MUST be non-empty, slash-delimited, and flagless, and the loader MUST validate it at load time. Timeout MUST be a positive `<integer><ms|s|m|h>`.

#### Scenario: Readiness timeout
- **WHEN** a placed server never prints the pattern before timeout
- **THEN** the step fails and preserves its pane

### Requirement: Canonical invocation context
Context MUST expose stable `workspace`, `tab`, `pane`, `worktree`, `cwd`, `agent`, `selection`, and `platform`, plus plugin-produced `transcript` and `transcript_file`. Platform MUST be `macos` or `linux`. Windows hosts run under WSL2, where the value is `linux`. Selection MUST be empty when absent. `cwd` MUST be the invocation's project root and MUST always be non-empty, so referencing it MUST NOT fail preflight. Referencing unavailable identity or transcript values MUST fail preflight. Transcript values MUST have a hard size cap. They MUST never enter automatic shell env or private per-run snapshot history, and import/editing surfaces MUST mark them visibly sensitive. Run cleanup MUST remove the transcript file on every path, and MUST start only after recovery completes. Run cleanup MUST remove managed response files only when the run succeeds, so a failed run keeps the agent output a step already wrote. `context.error` MUST exist only during recovery.

#### Scenario: Worktree action addressed by cwd
- **WHEN** a step calls `worktree.create` with `cwd: "{{context.cwd}}"`
- **THEN** the call receives the invocation's project root without a helper `git rev-parse` step

#### Scenario: Explicit transcript handoff
- **WHEN** reviewed YAML embeds `{{context.transcript}}` in a managed agent prompt
- **THEN** capped transcript text is sent to that profile without an additional runtime confirmation

#### Scenario: Failed run keeps managed output
- **WHEN** an agent step fails and the agent has written its managed response file
- **THEN** run cleanup removes the transcript file and keeps the managed response file on disk

#### Scenario: Recovery reads the transcript
- **WHEN** an `on_failure` step reads `{{context.transcript_file}}`
- **THEN** the transcript file still exists, because cleanup waits for recovery to finish

### Requirement: Workflow metadata and portable support claim
`title` and `description` MUST be optional text. Title MUST default from the humanized filename. `hidden: true` MUST suppress picker display but permit direct invocation. Documentation MUST describe v1alpha1 syntax and argv as portable across supported Linux and macOS hosts, with Windows users running both Herdr and the plugin inside WSL2.

#### Scenario: Windows uses the Linux runtime
- **WHEN** a Windows user runs Herdr and the plugin together inside WSL2
- **THEN** workflows execute through the supported Linux behavior without native Windows integration

### Requirement: Guarded sequential input collection
Mapped inputs MAY declare `when:` as one existing condition clause or a non-empty ordered list of clauses. Input conditions MUST reference only earlier inputs, MUST use short-circuit AND semantics, and MUST reject structured values. An inactive input MUST NOT prompt, resolve dynamic options, apply its default, enter the input namespace, or become an automatic `HWF_` environment value. Supplying an inactive entry or child input MUST fail collection. A conditional input reference MUST be a load error unless the consuming site is guarded by every clause that guards the input.

#### Scenario: Mode-specific entry inputs
- **WHEN** `mode` is `delete`, `branch` is guarded by `mode == "create"`, and `worktree` is guarded by `mode != "create"`
- **THEN** the entry picker asks for `worktree` but does not ask for or resolve `branch`

#### Scenario: Forward input dependency
- **WHEN** an input condition references an input declared after it
- **THEN** loading fails at that input condition with a forward-reference error

#### Scenario: Unguarded conditional input use
- **WHEN** a step references a conditional input without including all of that input's guard clauses
- **THEN** loading fails because the input is not proven available

### Requirement: Explicit custom choices and text length
A mapped choice input MAY declare `allow_custom: true`, in which case its options MUST be suggestions and entry or child values outside those options MUST be accepted as text. Omitting `allow_custom` MUST preserve closed choice membership. A mapped input MAY declare non-negative integer `min_length`; every active supplied or default value MUST contain at least that many characters. `allow_custom` MUST be invalid on text and profile inputs.

#### Scenario: Existing or new branch
- **WHEN** a choice offers existing branches with `allow_custom: true`
- **THEN** the picker accepts either a listed branch or newly typed non-empty branch

#### Scenario: Closed choice remains closed
- **WHEN** a choice omits `allow_custom` and receives a value outside its options
- **THEN** collection fails with the available values

#### Scenario: Empty required branch
- **WHEN** an active input declares `min_length: 1` and receives an empty value
- **THEN** collection fails before workflow step 1 and names the input and minimum length

### Requirement: Entry dynamic choices resolve once
Workflow loading and listing MUST validate dynamic-choice declarations without executing them. Entry input collection MUST execute only active dynamic choices, at most once per invocation, except that a choice whose resolved domain is discarded because an earlier answer changed MUST resolve again from the new answer. A detached picker run MUST reuse the option domains collected by its parent and MUST NOT execute those commands again. The detached runner MUST reject snapshots for undeclared, inactive, static, text, or profile inputs. Direct CLI and child invocation MUST each resolve their own active dynamic options once. Dynamic-choice argv MUST accept `inputs`-rooted templates only and MUST receive no partially collected input exports.

#### Scenario: Picker launches dynamic choice workflow
- **WHEN** the picker resolves one active dynamic choice and starts its detached run
- **THEN** the discovery command executes exactly once and the child validates against the same option snapshot

#### Scenario: Inactive dynamic choice
- **WHEN** a dynamic choice input has a false input condition
- **THEN** its command does not execute

#### Scenario: Dependent domain after an earlier answer changes
- **WHEN** a user navigates back and gives input `repo` a different value
- **THEN** the domain of the dependent choice is discarded and its command runs again with the new value

### Requirement: Statically selected pane placement
`pane.open` MAY be a whole-value template that references one unconditional, closed, static choice input. Every option of that input MUST be `tab`, `beside`, or `below`. Literal placement MUST retain its current behavior. Embedded templates and references to text, profile, custom, dynamic, conditional, step-result, or context values MUST be load errors at `pane.open`.

#### Scenario: Placement input
- **WHEN** `place` is the static choice `[tab, beside, below]` and `pane.open` is `{{inputs.place}}`
- **THEN** loading succeeds and the selected literal placement is used before pane creation

#### Scenario: Unbounded placement source
- **WHEN** `pane.open` references a text or custom-choice input
- **THEN** loading fails because the complete placement domain is not statically valid

### Requirement: Accepted local command exit codes
A blocking local `run` MAY declare `success_codes` as a non-empty list of unique integers. Omitting it MUST mean only exit code zero succeeds. A completed command MUST succeed exactly when it did not time out and its exit code is listed. Its natural result MUST retain stdout, stderr, exit code, and `failed`, where `failed` reports whether the command met this success rule. Spawn failure, timeout, and capture overflow MUST remain hard failures. Placed and background runs MUST reject `success_codes`.

#### Scenario: Optional capability probe
- **WHEN** a local probe exits one and declares `success_codes: [0, 1]`
- **THEN** the step succeeds, exposes `exit_code: 1`, and later conditions can skip the optional action

#### Scenario: Unexpected probe failure
- **WHEN** the same probe exits two
- **THEN** the workflow stops normally with the command's failure reason

### Requirement: Verdict-gated agent turns
An agent action MAY declare `expect` with `one_of`: a non-empty list of distinct tokens matching `[A-Z][A-Z0-9_]{0,31}`, and optional `require`: a non-empty subset of `one_of`. `expect` MUST be a load error on a background agent action. The runner MUST instruct the agent to end its managed response with exactly one `one_of` token on the final non-empty line, and to verify the response file with the `hwf response check` command until it exits zero before finishing the turn. The runner MUST parse `verdict` as the final non-empty line of the managed response after trimming, matched exactly against `one_of`. A response whose final non-empty line matches no `one_of` token MUST fail the step and name the expected tokens. When `require` is present and the parsed verdict is not in `require`, the step MUST fail and name the verdict and the required tokens. `verdict` MUST contain only the matched token; `response` MUST keep the complete text. Referencing `steps.<id>.verdict` when the producer declares no `expect` MUST be a load error. Existing condition, tolerated-failure, and recovery semantics MUST apply to verdict failures unchanged.

#### Scenario: Verdict drives a condition
- **WHEN** a reviewer step declares `expect: {one_of: [APPROVE, REJECT]}` and replies with prose ending in `REJECT`
- **THEN** the step succeeds, `{{steps.review.verdict}}` renders `REJECT`, and a later step gated on `== "REJECT"` runs

#### Scenario: Required verdict missing
- **WHEN** a step declares `require: [APPROVE]` and the agent's final non-empty line is `REJECT`
- **THEN** the step fails, the failure names `REJECT` and the required tokens, and normal failure handling applies

#### Scenario: Unparseable verdict
- **WHEN** the agent's final non-empty line matches no `one_of` token
- **THEN** the step fails and the error names the expected tokens

#### Scenario: Verdict reference without expect
- **WHEN** a template references `{{steps.review.verdict}}` and the `review` step declares no `expect`
- **THEN** loading fails and names the missing `expect` declaration

#### Scenario: Background agent with expect
- **WHEN** an agent action declares both `background: true` and `expect`
- **THEN** loading fails because a background turn produces no result

#### Scenario: Self-check instruction names the oracle
- **WHEN** a blocking agent step declares `expect: {one_of: [APPROVE, REJECT]}`
- **THEN** the submitted prompt names the tokens, the final-line rule, and the exact `hwf response check` command for the managed response path

