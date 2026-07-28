## ADDED Requirements

### Requirement: Alpha-versioned workflow document
A workflow requires string `version: v1alpha1` and a non-empty `steps:` list. It accepts only `version`,
`title`, `description`, `hidden`, `inputs`, `returns`, `on_failure`, and `steps` at top level. The parser
supports no other format or legacy shape. Future incompatible alpha formats use a new `v1alphaN` value.
They do not need to stay compatible with this one.

#### Scenario: Minimal alpha document
- **WHEN** a file contains `version: v1alpha1` and one step
- **THEN** the sole v1alpha1 parser loads it

#### Scenario: Unsupported alpha revision
- **WHEN** a file declares another format version
- **THEN** loading fails with the supported format and rewrite-or-upgrade guidance

### Requirement: Four explicit actions and strict modifiers
Every step carries exactly one action from `agent`, `run`, `herdr`, and `workflow`. Every step accepts
optional `id`, `when`, and `continue_on_error`. Agent actions also accept mutually exclusive `using` and
`target`, plus `cwd`, `env`, `pane`, `background`, and `timeout`. Run actions also accept `shell`, `cwd`,
`env`, `pane`, `background`, `ready_when`, `timeout`, and `retry`. Herdr actions also accept `params` and
`retry`. Workflow actions also accept `inputs`. Any other key is a load error. Dotted keys are never
inferred as actions.

#### Scenario: Multiple actions
- **WHEN** a step contains both `run` and `agent`
- **THEN** loading fails and names both actions

#### Scenario: Removed key
- **WHEN** a step declares `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, or `as`
- **THEN** loading fails with an ordinary unknown-key error and no compatibility handling

### Requirement: Explicit workflow template namespaces
Workflow templates use `{{path}}` rooted at `inputs`, `steps`, or `context`. The configuration-only
`{{prompt}}` sentinel is not a workflow template. Step IDs must match `[a-z][a-z0-9_]{0,31}` and stay
optional unless referenced. The loader rejects duplicate IDs, unknown paths, forward references, and
references to background, skipped, or otherwise result-less steps.

#### Scenario: Prior result
- **WHEN** a prompt references `{{steps.assess.response}}` from an earlier step ID
- **THEN** the resolved managed response is inserted

#### Scenario: Live focus is not context
- **WHEN** the user focuses another pane while a workflow runs
- **THEN** `{{context.pane}}` remains the pane captured at invocation

### Requirement: Typed template evaluation
A whole-value template in structured YAML preserves the source type. Embedded templates render strings
unchanged, booleans as lowercase text, finite numbers in decimal form, null as empty text, and arrays or
objects as compact JSON. Agent prompts always render to text.

#### Scenario: Structured RPC param
- **WHEN** a complete params value references a result object
- **THEN** the object remains structured rather than becoming JSON text

### Requirement: Natural step results
A blocking managed agent turn produces `{response, agent, pane_id}`, where `response` and `pane_id` are
strings and `agent` is native Herdr AgentInfo. A local command produces string `stdout`, string `stderr`,
integer `exit_code`, and boolean `failed`. A placed command that satisfies readiness produces the complete
native wait result, plus created pane/tab/workspace identifiers. A Herdr action produces its complete
native success result. A child workflow produces its declared returns. Background and skipped steps
produce no result. V1alpha1 does not support `out` or positional `previous`.

#### Scenario: Managed agent response
- **WHEN** a blocking agent settles and writes non-empty managed output
- **THEN** later steps can read `{{steps.review.response}}` and native agent metadata

#### Scenario: Missing managed output
- **WHEN** Herdr reports settlement but the managed response file is missing or empty
- **THEN** the agent step fails

### Requirement: Portable and shell run forms
`run:` accepts a non-empty string or non-empty string list. List form executes directly as argv on every
supported platform and allows templates per element. String form executes as shell source, rejects
templates, and accepts `shell:` values `sh`, `bash`, `zsh`, `pwsh`, `powershell`, and `cmd`. Omitted shell
means `sh` on macOS/Linux and `cmd` on Windows. Each input gets exported as `HWF_<name>`. Prior results
enter shell environments only through explicit `env:` mappings. Runner-generated values replace inherited
collisions. Explicit env keys reject reserved `HWF_` prefixes case-insensitively. The generated HWF
environment block has a 24 KiB cap. Captured command stdout plus stderr, managed agent response,
transcript text, and dynamic-choice stdout each have an 8 MiB cap. Crossing a cap fails the step, naming
the source and byte limit, rather than truncating output. Streaming commands get terminated when their
capture crosses the limit.

`shell` is invalid on argv. `cwd` is template-capable text. `env` is a string map with template-capable
values merged over inherited environment after reserved-key checks. Timeout on a local blocking run
terminates its process group and fails the step. Timeout is invalid on background. Omitted local-run `cwd`
uses workflow invocation cwd. Omitted local-run timeout means no workflow timeout, though process
completion still blocks the step.

#### Scenario: Portable argument
- **WHEN** argv contains a branch value with spaces
- **THEN** it reaches the process as one argument without a shell

#### Scenario: Unsafe shell interpolation
- **WHEN** shell source contains a workflow template
- **THEN** loading fails and directs the author to argv or explicit environment values

### Requirement: Named adaptive inputs
Input names must match `[a-z][a-z0-9_]{0,31}`. Values are `text`, `profile`, a non-empty static choice
list, or a strict map containing only `type`, `description`, `default`, and, conditionally, `options`. Map
type is `text`, `choice`, or `profile`. Choice requires static options or `{run: <argv>}`. Text and
profile reject options. Dynamic choice failure or empty output fails collection. Choice and profile
defaults must exist in the available values. Only the entry workflow prompts, in declaration order, and
unused inputs fail load.

Dynamic choice argv rejects templates, runs from repository root with the invoking environment, and
receives no partially collected input exports. Nonzero exit fails the step with capped stderr. Stdout
splits on LF/CRLF, trims surrounding whitespace, discards empty lines, and deduplicates while preserving
first-seen order. More than 1,000 choices, or crossing the shared capture cap, fails input collection.
Dynamic choice commands time out after 10 seconds and get terminated as a process group.

#### Scenario: Profile picker
- **WHEN** an input has type profile
- **THEN** the picker lists merged native-kind profile names in deterministic order

### Requirement: Managed native agent action
`agent:` contains non-empty prompt text. `using:` resolves a merged profile. When both `using` and
`target` are absent, the runner uses the merged `default_profile`. New-agent mode creates a
requested or default Herdr pane, calls native `agent.start` with profile kind/args, and submits through
`agent.prompt`. `target:` resolves an existing agent name or pane ID. It rejects `pane`, `cwd`, and `env`,
and submits through `agent.prompt` without launching a new agent. Blocking turns append the managed
response-file instruction and wait for `idle` or `done`. `blocked` sends one notification per blocked
episode and keeps waiting. `unknown` never counts as successful settlement. Omitted timeout defaults to 30
minutes and applies to the prompted turn. Native `agent.start` uses its own separate 30-second startup
default.

Before target-mode submission, the runner requires the existing agent to be `idle` or `done`. `working`,
`blocked`, and `unknown` fail before prompt submission, because Herdr does not correlate individual turns.
New-agent mode generates the required live name as a normalized step ID or `step-<ordinal>` prefix, plus a
per-run collision-resistant suffix, truncated to 32 characters while matching
`[a-z][a-z0-9_-]{0,31}`.

The settled-target check is advisory against obvious misuse, not the response correlation token: another
caller can race it, because Herdr has no atomic expected-state or turn ID. The unique managed response
path correlates completion. After prompt submission, the runner keeps observing until that exact
non-empty file exists and the target is idle or done, even if native prompt waiting returns for another
turn first. Timeout fails the step without accepting another turn's lifecycle as this result.

#### Scenario: Native profile turn
- **WHEN** a step uses profile `deep-review` backed by kind `claude`
- **THEN** Herdr starts Claude in the created shell pane, detects readiness, submits the prompt, and the
  plugin captures combined output

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
`agent` and `run` accept a `pane:` block containing only `open`, `target`, `workspace`, `size`, `focus`,
and `close`. `open` is `tab`, `beside`, or `below`. `beside` and `below` accept only `target`, default it
to invocation `context.pane`, and map to Herdr right/down splits. `tab` accepts only `workspace` and
defaults it to invocation `context.workspace`. `size` is an integer percentage from 1 through 99 for
splits, and it allocates that amount to the new pane. Foreground panes focus by default. Background panes
do not. Placement uses explicit captured IDs and never current UI focus.

`close` applies only to newly created managed agent panes and must be `success` or `always`. Omitting
`close` keeps the pane. `success` closes the pane only after successful settlement and response capture.
`always` closes the pane after any terminal outcome once a pane exists. Background actions reject `close`.
The `pane:` block requires `open`. New-agent mode that omits the complete block creates a new tab in the
invocation workspace, with foreground/background focus defaults unchanged. Run actions reject
`pane.close`, because readiness/background runs have no terminal cleanup point.

#### Scenario: Stable split
- **WHEN** the user changes UI focus before an omitted-target `beside` step
- **THEN** the runner splits the invocation pane through explicit `target_pane_id`

#### Scenario: Failed agent with success cleanup
- **WHEN** an agent with `close: success` times out
- **THEN** its pane remains visible for diagnosis

### Requirement: Herdr-owned background and readiness
`background: true` requires a newly created `pane:`, except when `target:` already addresses an existing
Herdr agent pane. It is mutually exclusive with `ready_when`, timeout, and pane cleanup. Local detached
background does not exist. Pane-owned background processes survive client detach but not ordinary server
restart. The runner never stops them implicitly after a later workflow failure.

A placed run requires exactly one of background or `ready_when: /regex/`. Readiness requires timeout and
delegates to native `pane.wait_for_output`, with source `recent` (matched by Herdr as `recent-unwrapped`),
80 rendered rows, ANSI stripped, and one logical-line Rust regex match. It succeeds only on native match.
Existing snapshot text can match. The workflow layer does not promise process-exit detection. The regex
must be non-empty, slash-delimited, and flagless, and the loader validates it at load time. Timeout is a
positive `<integer><ms|s|m|h>`.

#### Scenario: Readiness timeout
- **WHEN** a placed server never prints the pattern before timeout
- **THEN** the step fails and preserves its pane

### Requirement: Canonical invocation context
Context exposes stable `workspace`, `tab`, `pane`, `worktree`, `agent`, `selection`, and `platform`, plus
plugin-produced `transcript` and `transcript_file`. Platform is `macos`, `linux`, or `windows`. Selection
is empty when absent. Referencing unavailable identity or transcript values fails preflight. Transcript
values have a hard size cap. They never enter automatic shell env or run logs, and import/editing surfaces
mark them visibly sensitive. Run cleanup removes the transcript file. `context.error` exists only during
recovery.

#### Scenario: Explicit transcript handoff
- **WHEN** reviewed YAML embeds `{{context.transcript}}` in a managed agent prompt
- **THEN** capped transcript text is sent to that profile without an additional runtime confirmation

### Requirement: Workflow metadata and portable support claim
`title` and `description` are optional text. Title defaults from the humanized filename. `hidden: true`
suppresses picker display but permits direct invocation. Documentation must describe v1alpha1 syntax and
argv as cross-platform, while making runtime behavior subject to installed Herdr platform support.

#### Scenario: Windows beta capability gap
- **WHEN** syntax is valid but the installed Herdr reports a platform-unsupported operation
- **THEN** the workflow reports that native Herdr error rather than claiming runtime parity

## REMOVED Requirements

### Requirement: Workflow file shape
**Reason**: Replaced by strict alpha-versioned document shape.
**Migration**: Rewrite to `version: v1alpha1`.

### Requirement: One action key per step
**Reason**: Action meanings and modifier ownership are incompatible.
**Migration**: Use exactly one v1alpha1 action.

### Requirement: The run action and its three forms
**Reason**: Old bindings and forms are replaced by namespaced v1alpha1 execution.
**Migration**: Rewrite run steps.

### Requirement: Interpreter selection
**Reason**: Incorporated into v1alpha1 run behavior.
**Migration**: Use shell only with template-free string run form.

### Requirement: Step placement
**Reason**: Flat `in`/`ratio` is replaced by stable nested pane placement.
**Migration**: Use `pane:`.

### Requirement: Blocking by default
**Reason**: Old wait semantics are replaced by managed agents, background, and readiness.
**Migration**: Use v1alpha1 lifecycle controls.

### Requirement: Output binding
**Reason**: Results are automatic and addressed through IDs.
**Migration**: Remove `out` and reference `steps`.

### Requirement: Declared inputs
**Reason**: Input schema and profile semantics changed.
**Migration**: Rewrite inputs with v1alpha1 forms.

### Requirement: One flat name namespace
**Reason**: Replaced by explicit namespaces.
**Migration**: Use `inputs`, `steps`, or `context`.

### Requirement: Session placeholders
**Reason**: Custom session capture is renamed to transcript and moved under context.
**Migration**: Use `context.transcript` or `context.transcript_file`.

### Requirement: Human-readable labels
**Reason**: Metadata is replaced by title/description and optional step IDs.
**Migration**: Use v1alpha1 metadata.

### Requirement: Rejection of v1 spellings
**Reason**: Prior experimental naming and tailored migration errors are not maintained.
**Migration**: None; rewrite directly to v1alpha1.
