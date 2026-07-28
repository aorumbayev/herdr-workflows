## 1. V1alpha1 Grammar And Types

- [x] 1.1 Replace raw workflow and step schemas with required `version: v1alpha1`, four explicit actions, exhaustive step/recovery modifier and nested pane schemas, identifier rules, bounded percentages, duration grammar, and readiness regex validation
- [x] 1.2 Replace flat placeholder parsing with typed `{{inputs.*}}`, `{{steps.*}}`, and `{{context.*}}` path parsing plus canonical scalar and compact-JSON text rendering
- [x] 1.3 Replace flat output bindings and old action types with combined managed/native agent results plus natural command, readiness, Herdr, and child results
- [x] 1.4 Delete preprocessing, aliases, tailored legacy rejection errors, loop types, old retry forms, and every unversioned grammar path
- [x] 1.5 Add parser tests for valid v1alpha1 forms, unsupported alpha revisions, strict unknown keys, removed forms failing generically, template safety, durations, and pane validation

## 2. Profiles And Inputs

- [x] 2.1 Replace agent commands with strict non-empty `{kind, args?}` profiles delegated authoritatively to live Herdr `agent.start`, merged default profile, and rejection of legacy `agents`
- [x] 2.2 Move global config to `HERDR_PLUGIN_CONFIG_DIR`, add standalone discovery through Herdr, then layer committed project and gitignored local complete replacements
- [x] 2.3 Rename `sessions` extraction to kind-keyed `transcripts`, pass exact pane/kind/cwd/native-session environment, enforce the shared capture cap, and expose sensitive context without automatic env or log propagation
- [x] 2.4 Implement v1alpha1 text, choice, deterministic dynamic argv choices with parsing/limit rules, and native profile input resolution with defaults and unused-input validation
- [x] 2.5 Add config/input tests for config-directory discovery, replacement precedence, native kinds/args, missing defaults, transcript environment/failures/caps, dynamic parsing/failures/limits, and deterministic profile choices

## 3. Loading, References, And Composition

- [x] 3.1 Implement ID uniqueness, earlier-step path validation, schema-aware result fields, and producer-specific rejection of background, skipped, or tolerated-failure result references
- [x] 3.2 Implement isolated `workflow:` invocation with typed/domain-validated child `inputs:`, runtime dynamic-choice validation, cycle detection, entry-only prompting, and repository-over-global resolution
- [x] 3.3 Implement whole-value or non-empty named-map `returns:` validation, including structured values and null/empty rejection, and expose only declared child results
- [x] 3.4 Implement typed whole-value substitution for structured params, child inputs, and returns while retaining text rendering inside prompts and strings
- [x] 3.5 Add loader tests for forward references, absent and managed agent results, private child internals, required child inputs, typed values, returns, and cycles

## 4. Linear Runner

- [x] 4.1 Adapt local argv and shell execution to v1alpha1 results, action-specific shell/cwd/env/timeout validation, safe interpolation, reserved `HWF_<input>`, 24 KiB environment preflight, 8 MiB streaming capture termination, and platform defaults
- [x] 4.2 Implement new-agent mode through default/explicit pane creation, collision-safe Herdr agent naming, native startup with its 30-second deadline, prompt submission, blocked notifications, idle/done waits, and combined managed response/AgentInfo result
- [x] 4.3 Implement existing-agent target mode with idle/done precondition, busy-state rejection, native prompt, managed response capture, no pane controls, and background submission without a result
- [x] 4.4 Adapt explicit `herdr:` actions to generated validation, the version-pinned focus-fallback target policy, no context autofill, cross-field selector checks, variant-aware results, and complete structured natural results
- [x] 4.5 Implement nested `pane: tab|beside|below`, immutable invocation anchors, explicit result targets, percentage conversion, focus defaults, `close: success|always`, and pane-only background ownership
- [x] 4.6 Implement thin `ready_when` through native recent/80-line/ANSI-stripped wait semantics with required timeout and no process-exit promise
- [x] 4.7 Implement scalar-only `when`, producer-specific tolerated failure, constrained retries, entry-only recovery, nested attribution, and fail-safe no-recovery handling for any uncertain Herdr transport interruption
- [x] 4.8 Update progress and run-log records for optional IDs and skipped, succeeded, failed, launched, blocked, and coordination-interrupted outcomes without transcript leakage
- [x] 4.9 Add runner tests for exact results/errors, native start/prompt order, blocked/unknown states, stable targeting under focus changes, cleanup policies, background persistence, readiness, context preflight, transcript cleanup, recovery, and uncertain transport interruption
- [x] 4.10 Preserve and test command output, managed response, transcript, template expansion, and environment size boundaries

## 5. Authoring Surfaces

- [x] 5.1 Update picker metadata and adaptive input screens for title, description, v1alpha1 choices, native profiles, and repo/global provenance
- [x] 5.2 Update workbench cards for managed agent modes, nested pane controls, combined results, context, and v1alpha1 validation
- [x] 5.3 Update import/sharing to preserve v1alpha1 exactly, require review, and visibly flag commands, transcript access, and sensitive Herdr methods
- [x] 5.4 Add picker, web, and import tests for provenance, sensitive-reference visibility, metadata, inputs, actions, and strict rejection

## 6. Schema, Examples, And Documentation

- [x] 6.1 Regenerate JSON Schema from v1alpha1 and verify all actions, agent modes, and pane blocks
- [x] 6.2 Rewrite every shipped example/background workflow and config to v1alpha1 with no legacy syntax remaining
- [x] 6.3 Rewrite docs around alpha versioning, native profiles, combined results, canonical context/transcripts, pane ownership, persistence limits, portable syntax, and explicit Herdr calls
- [x] 6.4 Document workflows as trusted executable code and the denylist as a bypassable accidental-misuse safety rail; update the authoring skill to generate only v1alpha1
- [x] 6.5 Search the repository for every removed key, placeholder form, old version label, and compatibility statement; delete or rewrite each product-facing occurrence

## 7. End-To-End Verification

- [x] 7.1 Run the full unit suite and `npm run verify`, fixing failures without reintroducing compatibility code
- [ ] 7.2 Run disposable-Herdr smoke tests for new/existing managed turns, blocked handling, transcript handoff, stable pane targeting during focus changes, readiness, child composition, and recovery
      - verified live: new managed turn (`using:` → PONG captured via managed file, file cleaned up), existing-agent
        `target:` turn (TARGETOK), readiness via `pane.wait_for_output`, stable pane targeting with the anchor
        process surviving, child composition with `returns:`, recovery with `context.error` details, run-log
        `returns`, `hwf init` writing v1alpha1 config, legacy `agents:` config rejected
      - not verified live (unit fakes only): blocked handling (no deterministic way to force an approval UI),
        busy-target rejection (real turns settled too fast to observe), transcript handoff (needs the workflow
        invoked from inside a live agent pane)
- [ ] 7.3 Run native Windows smoke tests for argv, native profile launch, pane background, readiness, transcript preflight, and platform-unsupported propagation
      - not run: no native Windows host available in this environment
- [x] 7.4 Confirm the package stays semver `0.x`, the workflow format is `v1alpha1`, future breaking alpha changes increment `v1alphaN`, and the manifest/CLI alone enforce Herdr version/protocol
- [x] 7.5 Perform a final Herdr-doc-backed diff review proving no duplicated stronger runtime promises, old files fail rather than normalize, and no aliases/migrations remain
