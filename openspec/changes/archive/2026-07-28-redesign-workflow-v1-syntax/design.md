## Context

herdr-workflows parsed an experimental, unversioned grammar that exposed implementation details such as
dotted RPC keys, overloaded agent configuration, explicit output bindings, a flat namespace,
pane-oriented retry resets, and unused loop machinery. The product is not a scheduler. It automates
short, supervised rituals inside Herdr while the user stays involved and the plugin limits concurrent
agent sessions.

Herdr 0.7.5 already owns workspace/tab/pane topology, recognized agent kinds and lifecycle, process
persistence, invocation context, plugin config/state directories, and a generated Socket API. The plugin
must compose those primitives rather than independently recreate stronger or conflicting behavior.

## Goals / Non-Goals

**Goals:**

- Establish one strict alpha workflow format identified by `version: v1alpha1`.
- Keep workflows linear while covering portable commands, managed agent turns, direct Herdr RPC, child
  workflows, readiness waits, recovery, and adaptive inputs.
- Make data provenance explicit and preserve native Herdr identities and result shapes.
- Anchor pane creation to stable invocation or explicit result IDs, never mutable UI focus.
- Let teams commit role-oriented profiles while Herdr resolves native agent executables per platform.
- Preserve strict command-injection boundaries and describe trusted-workflow security accurately.

**Non-Goals:**

- Parsing, diagnosing, migrating, or documenting earlier experimental workflow/config spellings.
- Parallel branches, joins, DAG scheduling, queues, autonomous overnight execution, or loops.
- Supporting arbitrary executables as `agent:` actions; ordinary processes use `run:`.
- Sandboxing workflow code or treating the Herdr method denylist as authorization.
- Promising runtime feature parity beyond the installed Herdr platform's capabilities.
- Preserving in-flight workflow coordination across Herdr live handoff.

## Decisions

### Use an alpha-qualified document format version

Every workflow requires `version: v1alpha1`, following Kubernetes, Argo, and Tekton conventions for an
unstable persisted API. A later incompatible alpha refinement increments to `v1alpha2`. Beta becomes
`v1beta1`; stable becomes `v1`. The parser supports only its current alpha format and provides no alpha
compatibility layer. Package releases stay independently versioned as `0.x`.

Workflow YAML does not duplicate a Herdr requirement. The plugin manifest declares `min_herdr_version`.
Startup checks the live version and protocol before input collection or execution. Generated method
validators and structural profile validation stay pinned to the vendored Herdr schema. Live `agent.start`
stays authoritative for kind support. Supporting a newer Herdr method requires a plugin release, and a
manifest minimum bump when necessary.

### Keep four direct ritual actions

Each step has exactly one action: `agent`, `run`, `herdr`, or `workflow`. The design rejected a uniform
`do:` object as repetitive, and natural-language action inference as unsafe. `herdr: <method>` gives a
clear boundary around raw allowed Socket API calls; `params:` carries their typed request.

### Build managed agent turns on native Herdr primitives

`agent:` contains prompt text and operates in exactly one mode:

- `using: <profile>` creates a shell pane, calls native `agent.start` with the profile's recognized
  Herdr kind and startup args, then calls `agent.prompt`.
- `target: <agent-name-or-pane-id>` calls `agent.prompt` against an existing recognized agent and rejects
  pane creation controls.

When neither key is present, new-agent mode uses the merged `default_profile`. `using` and `target` stay
mutually exclusive.

Profiles contain only `kind` and optional `args`. Herdr owns canonical executable discovery, startup
readiness, process-tree/integration detection, and cross-platform launch. Arbitrary or unrecognized
processes stay `run:` actions. Herdr's live `agent.start` validation is authoritative, because its API
schema does not enumerate supported kinds.

For blocking turns, the runner appends an absolute managed response-file instruction, waits for native
lifecycle state, then reads the file. `blocked` sends a notification and keeps waiting for `idle` or
`done`. `unknown` never means successful completion. Missing or empty managed output fails the step. The
result is `{response, agent, pane_id}`, where `agent` is native Herdr AgentInfo. Raw `herdr: agent.prompt`
stays available, but it returns lifecycle metadata, never response prose.

Background agent turns complete start and prompt submission, then return without a result or join. Target
mode requires the existing agent to be idle or done before submission; busy, blocked, and unknown targets
fail rather than risk completion from an earlier turn. New starts receive a normalized step-based name
plus a short per-run suffix, so Herdr's required live name stays unique. Agent turn timeout defaults to 30
minutes; native startup keeps its own separate 30-second default. The unique managed output path, not
Herdr lifecycle alone, correlates a target turn: after submission the runner waits for that exact file and
final settled state, even when native waiting first observes another turn complete.

### Use explicit namespaces and typed natural results

Workflow templates use `{{...}}` under exactly three roots:

- `inputs` contains entry values or explicit child arguments.
- `steps` contains earlier identified natural results.
- `context` contains stable invocation facts and recovery error details.

Step IDs stay optional unless referenced, unique, and local to one workflow. Forward references and
references to background, skipped, or result-less tolerated actions are load errors. Blocking actions
produce natural structured results: managed agent result, local command streams/status, readiness pane
metadata, complete Herdr success response, or child `returns:`. Whole-value structured templates preserve
type. Embedded rendering uses unchanged strings, decimal numbers, lowercase booleans, empty text for null,
and compact JSON for arrays/objects.

### Keep linear execution and evidenced controls

Steps execute in document order. V1 keeps scalar `when`, `continue_on_error`, constrained retry for
blocking local commands and Herdr calls, and one entry-workflow `on_failure` action. It excludes loops,
shell/argv guards, retry predicates/resets, step-scoped recovery, and pane-creating retries.

Tolerated failures continue execution, suppress recovery, and leave final CLI status nonzero. Child
failures bubble to the directly invoked entry workflow's single recovery action. Parse, preflight, and
live-handoff coordination failures skip recovery.

### Separate pane placement from execution semantics

`agent` and `run` may carry a `pane:` block:

```yaml
pane:
  open: tab | beside | below
  target: "{{context.pane}}"
  workspace: "{{context.workspace}}"
  size: 40%
  focus: false
  close: success | always
```

`target` applies to `beside`/`below`; `workspace` applies to `tab`. When omitted, split placement anchors
to the pane that invoked the workflow, and tab placement anchors to its workspace. These are immutable
invocation IDs, never current UI focus. Explicit prior result IDs override them. `beside` means Herdr's
right split; `below` means down. `size` allocates the percentage to the new pane. Foreground creation
focuses by default; background creation does not.

The pane block requires `open`. Omitting it for a new agent creates a tab in the invocation workspace.
Run panes reject `close`, because background/readiness processes have no terminal cleanup point.

Omitted `close` keeps the pane. `success` closes the pane only after successful lifecycle settlement and
response capture. `always` closes the pane after every terminal outcome once a pane exists. Existing-agent
target mode rejects the pane block.

`background`, `ready_when`, and `timeout` stay execution controls outside `pane:`. Background requires a
newly created Herdr pane or an existing-agent target; local detached commands are removed. Pane-owned
background processes survive client detach, not ordinary server restart, and are never implicitly stopped
after a later workflow failure. Background rejects pane cleanup and timeout.

### Keep readiness as thin native sugar

A placed run chooses exactly one of background launch or `ready_when: /regex/`. Readiness requires an
explicit timeout and delegates to `pane.wait_for_output` with Herdr 0.7.5 defaults: `recent` source
matched as `recent-unwrapped`, 80 rendered rows, ANSI stripped, and one logical-line Rust regex match. It
can match any current snapshot text and does not promise process-exit detection. Advanced source/window
behavior uses explicit Herdr calls.

### Fail safely across transport interruption

Herdr exposes no reliable signal that distinguishes live handoff from another transport loss. Any
unexpected disconnect after an agent, placed run, or RPC dispatch counts as uncertain coordination loss.
The runner does not replay or infer completion; it stops, preserves panes, skips `on_failure`, and reports
that the underlying action may still be active.

### Make child workflows explicit APIs

`workflow: <name>` invokes a child with explicit `inputs:`. The child receives only those values and
stable context, never the parent's step namespace. It exposes only a top-level whole-value template or a
non-empty named-map `returns:`. Only the entry workflow prompts. Cycles and unsatisfied child inputs
remain load errors.

### Preserve portable argv and explicit shells

List-form `run:` is direct argv execution and permits templates per argument. Scalar/block strings are
shell source, reject templates, and use an explicit or platform-default shell. Shell steps receive inputs
as `HWF_<name>`; prior results enter only through explicit `env:`. The generated HWF environment is capped
at 24 KiB. Each captured command result, managed response, transcript, or dynamic-choice output is capped
at 8 MiB and fails rather than truncates. This guarantees portable syntax and argv behavior, not Herdr
runtime parity on beta platforms.

### Use canonical Herdr context and honest transcript semantics

Context exposes stable invocation `workspace`, `tab`, `pane`, `worktree`, `agent`, `selection`, and
`platform`, plus plugin-provided `transcript` and `transcript_file`. These names avoid collision with
Herdr server sessions, native session references, and live handoff.

Transcript use is explicit consent in reviewed executable YAML. It has a hard size cap, is never
automatically exported to shell environments or run logs, and is visibly marked as sensitive in import and
workbench views. Missing extraction support fails preflight. Documentation states that the selected
profile/provider receives transcript content. Extractors receive the exact invoking pane, native kind,
cwd, and available native session reference through reserved environment variables, so same-kind
concurrent agents stay distinguishable.

### Layer plugin-owned profile and transcript configuration

Global configuration lives at `$HERDR_PLUGIN_CONFIG_DIR/config.yaml`, discovered through Herdr when the
standalone CLI lacks injected environment. Committed `.hwf/config.yaml` overrides global defaults;
gitignored `.hwf/config.local.yaml` replaces project profiles or extractors per machine.
Higher-precedence entries replace whole names; the highest declared valid `default_profile` wins.

Profiles contain strict `{kind, args?}`. `type: profile` inputs list merged profile names. Custom
`transcripts:` extractors are keyed by native Herdr kind and replace the experimental `sessions:` key.

### Treat workflows as reviewed executable code

Repo workflows carry the same trust as repo scripts. Imported global workflows display full YAML and
require confirmation. Nothing auto-runs merely because a repo opens; picker/workbench show provenance and
highlight commands, transcript use, and sensitive Herdr calls.

The Herdr method denylist is an authoring and runtime safety rail. It prevents accidental server/plugin
self-destruction, nonterminating subscriptions, authority corruption, global Agent-view ownership,
popup/plugin-pane lifecycle misuse, and experimental graphics calls. It is not a sandbox: `run:` can call
the full Herdr CLI or socket as the current user.

Raw `herdr:` actions never autofill target params. Authors pass exact API selectors explicitly from
canonical context or prior results. This prevents an omitted selector from falling through to mutable UI
focus, and it avoids duplicating method-specific mutual-exclusion semantics.

## Risks / Trade-offs

- [Native kinds exclude custom harnesses] → Run unrecognized processes with `run:` until Herdr supports
  their agent lifecycle.
- [Managed response relies on agent compliance] → Missing/empty output is an explicit failure, and the
  pane stays preserved unless `close: always` was deliberately selected.
- [Readiness is terminal scraping] → Keep native semantics narrow, require timeout, and recommend real
  health commands where available.
- [Alpha workflow versions churn] → Make incompatibility explicit with `v1alphaN` and provide no hidden
  normalization.
- [Transcript can contain secrets] → Require reviewed explicit reference, visible warnings, a hard cap,
  and no automatic logs/env propagation.
- [Safety rail can be bypassed] → State the trusted-code model prominently and never market deny rules as
  authorization.
- [Windows Herdr is beta] → Test native Windows core paths and phrase support as portable syntax over
  installed Herdr capabilities.

## Migration Plan

1. Replace the parser, types, and schema with the sole `v1alpha1` grammar and delete every legacy path.
2. Move global config into Herdr's plugin config directory; implement native-kind profiles and renamed
   transcript extractors.
3. Adapt agent execution to pane creation plus native start/prompt/wait and combined managed results.
4. Adapt stable pane targeting, readiness, direct Herdr calls, context, composition, and control flow.
5. Update picker/workbench trust provenance and sensitive-reference visibility.
6. Rewrite examples/docs/schema and run unit, verification, native Windows, and disposable-Herdr smoke
   tests.

There is no in-place migration. Rollback restores the earlier package and workflow/config files from
source control.

## Open Questions

None. Further alpha refinements require a new `v1alphaN` proposal.
