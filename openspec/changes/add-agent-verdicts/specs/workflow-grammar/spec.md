# workflow-grammar Delta

## MODIFIED Requirements

### Requirement: Four explicit actions and strict modifiers
Every step MUST carry exactly one action from `agent`, `run`, `herdr`, and `workflow`. Every step MUST accept optional `id`, `when`, and `continue_on_error`. Agent actions MUST also accept mutually exclusive `using` and `target`, plus `cwd`, `env`, `pane`, `background`, `timeout`, and `expect`. Run actions MUST also accept `shell`, `cwd`, `env`, `pane`, `background`, `ready_when`, `timeout`, `retry`, and `success_codes`. Herdr actions MUST also accept `params` and `retry`. Workflow actions MUST also accept `inputs`. Any other key MUST be a load error. Dotted keys MUST never be inferred as actions. Keys such as `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, and `as` MUST fail as unknown keys.

#### Scenario: Multiple actions
- **WHEN** a step contains both `run` and `agent`
- **THEN** loading fails and names both actions

#### Scenario: Unknown step key
- **WHEN** a step declares `out`, `wait`, `in`, `ratio`, `allow_fail`, `for`, or `as`
- **THEN** loading fails with an ordinary unknown-key error

### Requirement: Natural step results
A blocking managed agent turn MUST produce `{response, agent, pane_id}`, where `response` and `pane_id` are strings and `agent` is native Herdr AgentInfo. A blocking managed agent turn that declares `expect` MUST also produce string `verdict`. A local command MUST produce string `stdout`, string `stderr`, integer `exit_code`, and boolean `failed`. A placed command that satisfies readiness MUST produce the complete native wait result, plus created pane/tab/workspace identifiers. A Herdr action MUST produce its complete native success result. A child workflow MUST produce its declared returns. Background and skipped steps MUST produce no result. V1alpha1 MUST NOT support `out` or positional `previous`.

#### Scenario: Managed agent response
- **WHEN** a blocking agent settles and writes non-empty managed output
- **THEN** later steps can read `{{steps.review.response}}` and native agent metadata

#### Scenario: Missing managed output
- **WHEN** Herdr reports settlement but the managed response file is missing or empty
- **THEN** the agent step fails

## ADDED Requirements

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
