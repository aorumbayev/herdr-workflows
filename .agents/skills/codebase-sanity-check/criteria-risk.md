# Group C: Risk and Regression

Workflow YAML is author-written and trusted. A `run:` step can call anything. That is the design, so
do not report it as a vulnerability. Report where a **rail the product promises** does not hold,
where data leaks across a boundary, or where a cap fails open. Then, on a branch, report the ways a
change made the repository weaker than it was.

**Sections 1 to 5 always run. Sections 6 to 10 run in `branch` scope only**, because each compares a
diff against what was asked. Skip them when there is no diff.

**Boundary:** a rail with no enforcing site at all is Group B. You own the case where the rail exists
but has a hole. Docs overselling a rail is Group B's prose beat, but report it here too, because a
false safety claim is a security defect.

**Never propose deleting validation to reduce lines.** Deletion is cheap everywhere else in this
review. Not here.

## 1. Template and command injection rails

The product promises that string-form `run:` command text rejects templates at load, and that
list-form `run:` passes argv elements. That promise is the rail.

### What to check

- A path where a template value reaches shell text rather than an argv element
- A path where `env:` or generated `HWF_<name>` values reach a shell interpreter unquoted
- `herdr:` `params:` rendered into a command string anywhere
- A whole-value template losing its type and becoming interpolated text

### How to measure

- `rg -n 'exec\.Command|exec\.CommandContext' internal` and classify every hit as argv or shell text.
  Read `internal/engine/command.go` and `internal/workflow/inputs.go` for the shell-form path
- For each shell-text hit, trace the argument back to its source. Cite the line where user data
  enters
- Confirm the load-time rejection exists and is reached:
  `rg -n "templates are not allowed" internal/workflow` and the test that pins it
- Prove the rail rather than reading it: load a workflow with a template inside string `run:` through
  the loader and quote the error

### Not a finding

- A trusted `run:` step calling the herdr CLI. `AGENTS.md` states the denylist is a misuse rail, not
  a sandbox

## 2. Caps and failing loud

`internal/caps/` holds the caps. Crossing one must fail, naming the source and the limit. Truncation
is a data-integrity defect, not a graceful degradation.

### What to check

- A read, capture, or environment build that truncates instead of failing
- A cap checked after the data was already written or sent
- A cap enforced on one path and not on a sibling path, such as entry but not child
- An unbounded read with no cap at all

### How to measure

- `rg -n "\[:.*\]|Truncate\(" internal` and check each against a cap constant
- `rg -n "CaptureByteLimit|HwfEnvByteLimit|AgentPromptByteLimit" internal` and confirm every capture, transcript,
  managed response, and environment path checks its cap
- Quote the failure message from a test that crosses a cap

## 3. Secrets and leakage

### What to check

- A token, cookie, or credential reaching the run log, a transcript capture,
  or a notification
- Environment dumped wholesale into a log or a child process
- A secret in a shareable artifact, such as a shared or exported workflow
- Any file the product creates holding a credential

### How to measure

- `rg -in "token|secret|password|api[_-]?key|authorization|bearer" internal` and classify each as read, store, or emit. Only emits are findings. Credential ACL helpers in
  `internal/credentials/` own private credential checks, so judge
  their file mode and callers, never their existence
- Read `internal/history/` and `internal/transcript/` and name exactly what they write
- For any credential file, require restrictive creation mode and a refusal to follow symlinks:
  `rg -n "0o600|O_NOFOLLOW|chmod|FileMode" internal`. A credential file created with default mode is a
  finding
- Read `internal/workflow/exchange.go` and `internal/workflow/inputs.go` and name exactly what a shared,
  exported, or `--launch-payload` workflow carries

## 4. Install, update, and release path

### What to check

- A download that is not pinned to a release tag
- A downloaded binary or schema with no integrity check
- A schema or asset URL pointing at `main` rather than the version that matches the installed plugin
- An update path that can install across a protocol break without a version check
- Third-party GitHub Actions not pinned to a commit SHA

### How to measure

- `rg -n "https://" internal scripts herdr-plugin.toml .github/workflows | rg -v "^Binary"` and check
  each URL for a version pin
- `rg -n "main/docs|refs/heads/main|/latest/" internal scripts docs herdr-plugin.toml`
- `rg -n "uses:" .github/workflows/*.yml` and flag any tag-only pin
- Read the update path in `internal/update/` and `internal/cli/update.go` and name the version comparison and what happens on mismatch

## 5. Dependency supply chain

Read `go.mod` and `docs/package.json`. Go module versions should be explicit. `golangci-lint run` already reports unused symbols — quote it
rather than re-deriving it. What it cannot see is a runtime dependency reached from one site with a
small used surface. Count import sites with `rg -c '"<module/path>"' internal` and name the stdlib that
replaces it.

---

The remaining sections need a diff. In `branch` scope, read the diff you were given and the task the
branch claims to complete — the pull request body, the OpenSpec change under `openspec/changes/`, or
the commit messages. Pre-existing problems in unchanged code are out of scope. A change that newly
breaks unchanged code is in scope.

## 6. Check weakening (branch only)

The most expensive copout, because it converts a caught defect into an uncaught one.

### What to check

- New `//nolint` or `golangci-lint` disable comments without justification
- New unchecked type assertions or `any` casts added to silence a type error
- A relaxed `verify:*` threshold, a new ignore in a verify script, or a lowered `--max-warnings`
- A test skipped, deleted, or renamed out of the run
- An assertion made weaker, such as an exact comparison replaced by a presence check
- A cap raised in `internal/caps/` with no requirement behind it

### How to measure

Every check below reads added lines only.

- `git diff origin/<base>...HEAD | rg "^\+.*(nolint:|//lint:ignore|as any|: any\b)"`
- `git diff origin/<base>...HEAD -- scripts/verify-* .golangci.yml`
- `git diff origin/<base>...HEAD -- internal e2e | rg "^\+.*(t\.Skip|NotNil\(|NoError\()"`
- `git diff origin/<base>...HEAD -- internal e2e | rg "^-.*func Test"` for removed cases
- `git diff origin/<base>...HEAD -- internal/caps`

Any hit is Critical unless the diff or the change document states the reason. Quote the reason and
judge it.

### Not a finding

- A disable with a specific justification naming the rule and why it does not apply. A justification
  that suppresses an error the line itself manufactures is not a justification
- A cap change that an OpenSpec change explains
- An ignore covering a generated file whose generator is itself checked. Group B section 10 owns that
  judgment. Defer to it rather than flagging the ignore twice with opposite verdicts

## 7. Scope escape (branch only)

### What to check

- "Out of scope" applied to something the task requires
- A stub, placeholder, or hardcoded return where real behavior was asked for
- Work split so the branch leaves the feature half-wired
- A phase-two promise with no phase two anywhere

### How to measure

- `git diff origin/<base>...HEAD | rg -in "^\+.*(out of scope|not in scope|beyond the scope|follow-?up|future PR|separate PR|phase 2|later)"`
- `git diff origin/<base>...HEAD | rg "^\+.*(not implemented|TODO.*implement|// stub|panic\(\"TODO)"`
- Compare the task's completion items against the diff item by item. A completion item with no
  matching change is the finding, and you must name the item

### Not a finding

- An item the change document lists under non-goals
- A deliberate placeholder the change document designs, such as a hook awaiting a separate API task

## 8. Deflection (branch only)

### What to check

- A new comment blaming prior state instead of fixing it
- "Already broken", "pre-existing", "was like this" without evidence or a tracked issue
- Broken code left untouched with an explanation attached

### How to measure

- `git diff origin/<base>...HEAD | rg -in "^\+.*(pre-existing|already broken|already like this|not my|existing issue)"`
- For each hit, check whether a tracked issue or an OpenSpec change exists. Absent means finding

### Not a finding

- A genuine pre-existing issue filed for follow-up, provided the current task's own criteria are met

## 9. Partial completion (branch only)

### What to check

- A component, module, or step type added but never reached from an entry point
- A new export missing from the surface that would make it usable
- A test file with `t.Run` blocks and no assertions
- Docs, specs, or generated artifacts not updated alongside a behavior change
- An empty `catch` swallowing an error

### How to measure

- For each new export in the diff, grep for a call site outside its own file
- `git diff origin/<base>...HEAD --name-only` and check the pairings the repository requires:
  a loader change with no `docs/workflow.schema.json` change, or a
  behavior change with no change under `openspec/`
- `git diff origin/<base>...HEAD | rg "^\+.*_\s*=\s*err\s*$|^\+.*if err != nil \{\s*\}"`

### Not a finding

- A generated artifact that Phase 0 regeneration produced no diff for

## 10. Defer language and process shortcuts (branch only)

### What to check

- New `TODO`, `FIXME`, `HACK`, `WORKAROUND`, or `TEMPORARY` for in-scope work
- "Good enough for now" where the task asked for more
- `WIP` or `temp` commit messages on a branch heading for merge
- A commit on `main` or `master`
- An agent-attribution trailer in a commit message or the pull request body

### How to measure

- `git diff origin/<base>...HEAD | rg "^\+.*(TODO|FIXME|HACK|WORKAROUND|TEMPORARY|good enough)"`
- `git log origin/<base>..HEAD --oneline | rg -in "wip|temp|quick fix"`
- `git log origin/<base>..HEAD --pretty=%B | rg -in "^(co-authored-by|generated with)|🤖"`. Any hit
  is a finding. `AGENTS.md` bans these and states the hook is only a backstop. Match the trailer
  forms, not the bare word `claude` — this repository has `CLAUDE.md`, so commit bodies mention it
  legitimately
- `git branch --show-current`. `main` or `master` is Critical

### Not a finding

- A `TODO` with a linked issue for work the change document places outside this branch
