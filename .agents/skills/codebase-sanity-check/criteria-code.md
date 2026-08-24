# Group A: Code and Tests

The reader is one maintainer holding the whole repository in their head. Your job is to shrink what
they must hold, and to check that the tests would notice if the code broke.

Your brief is wide because this repository runs three review agents, not seven. Work the sections in order
and do not stop early.

**Boundary:** a rule with no enforcing site anywhere is Group B. Duplication of _code_ is yours, and
duplication of a _rule_ across code and prose is Group B. Security validation is Group C, and you
never propose deleting it.

**Read first:** `AGENTS.md` sections "Layout", "Hard constraints" (Splitting, Comments), and "Code
style". The Layout table is the intended mental model. Unit tests use temp dirs and injected deps.
The `e2e/` harness builds the binary and runs shipped examples. A test that escapes isolation can
pass locally and fail in CI.

## 1. The splitting trap

Read the "Splitting" constraint in `AGENTS.md` before this section. It owns the file-length cap,
the per-function cyclomatic ceiling, and the nesting gates. Take the numbers from there, not from
here.

The one conclusion you must carry: never propose a split only to satisfy a line budget or a
complexity number when the code already names one concept.

### What to check

- A file created to satisfy a score or a line budget rather than to name a concept
- A directory whose files must all be read together to follow one flow
- A function whose nesting or callback depth makes it hard to follow, which is the real readability
  signal

### How to measure

- Quote `go run ./scripts/verify-file-length` for any Go file near the line cap
- `golangci-lint run` reports complexity and nesting in Go packages
- `git log --diff-filter=A --name-only --oneline -20 -- internal` for recently added files. For each,
  find its callers with `rg -n "<package>"`. One caller and no test of
  its own means the split bought nothing

### Not a finding

- A file that `go run ./scripts/verify-file-length` fails on today. Shrinking it is required,
  and shrinking may mean deleting rather than splitting
- A long but linear function under the file-length cap, such as a parser or a schema. Function
  length alone is ungated by design

## 2. Abstractions with one user

### What to check

- An interface, abstract type, or union with exactly one implementation
- A factory, builder, or registry producing one product
- A wrapper function that only forwards arguments
- A config key, option, or parameter that every call site leaves at its default
- A type alias used once

### How to measure

- For each exported symbol in a candidate file, count real call sites:
  `rg -n "\b<symbol>\b" internal --type go | grep -v "<defining file>" | wc -l`
- For an option, grep for the option name and check whether any caller passes a non-default value
- `golangci-lint run` and dead-code findings in test output. Quote linter output rather
  than re-deriving it.

### Not a finding

- A single implementation behind an interface that a test double also implements. The test is the
  second user
- Loader schemas and their inferred types. One schema, one type, by design

## 3. Duplication

### What to check

- The same logic in two places, where a fix must be applied twice
- Two code paths that implement one rule, such as validation in the loader and again in the web
  endpoint
- Copy-adapted helpers that differ only in a literal

### How to measure

- For each hard constraint in `AGENTS.md`, grep for its
  error text or its rule name across `internal/` and count the enforcing sites. More than one enforcing
  site for one rule is a finding unless the second is a deliberate defense in depth that a comment
  or test names
- When two sites look identical, read both and cite the lines

### Not a finding

- Generated files. `internal/host/herdr_methods.gen.go` and `docs/workflow.schema.json` are outputs
- Test fixtures repeating shape on purpose

## 4. Dead code and dead flexibility

### What to check

- Exports nothing imports
- Branches no input can reach, including a `when:` form or CLI flag no surface produces
- Error paths for conditions the caller already rejected

### How to measure

- `golangci-lint run` for unreachable exports
- For an unreachable branch, trace backward to the entry point in `internal/cli/` or
  `internal/picker/`. If no entry point can produce the input, quote the entry-point line as evidence
- A gate whose scope makes it impossible to fire is the same defect in the tooling. That one belongs
  to Group B, which audits the gates

### Not a finding

- Defensive validation at a trust boundary. Never delete input validation to reduce lines. See
  `criteria-risk.md`

## 5. Comments

Read the "Comments" constraint in `AGENTS.md`. `go run ./scripts/verify-comments` fails a comment block
over two lines. Godoc on exported symbols is exempt, and so is a block whose first line starts
`context:`, which means a durable fact the code cannot express and which pages a human for approval.

### What to check

- Comments restating the next line
- Section banners and file headers that add no information
- A stale comment describing behavior the code no longer has
- A `context:` block that does not carry a durable fact, so it spends the escape hatch on narration
- A comment padded to fit under the two-line gate rather than deleted

### How to measure

- Quote `go run ./scripts/verify-comments` output. It already reports what it flags
- `rg -n "context:" internal` and read each block. Judge whether the code could express the fact instead
- For stale comments the gate cannot judge, read the comment and the code beneath it and quote both

### Not a finding

- A comment naming a non-obvious constraint, an upstream bug, or a deliberate ceiling

## 6. The mental model

### What to check

- One abstraction loads and validates workflows, one runs them, one per step type. Verify
  `internal/workflow/` and `internal/engine/` still hold that shape
- A concept that lives in two folders
- A folder holding one file with no sibling planned
- `AGENTS.md` Layout rows that name a path that no longer exists, or paths under `internal/` with no row

### How to measure

- `ls internal/*/` against the Layout table in `AGENTS.md`, row by row. A row that names packages
  the directory no longer holds is drift in the table. A package with no row is drift in the code
- The same listing shows single-file folders

## 7. Tests that cannot fail

Coverage percentage is not the question. The question is whether a test can fail when the product
breaks.

### What to check

- An assertion that restates the implementation, such as comparing a constant to the same imported
  constant
- A test whose only assertion is that a mock was called
- A snapshot with no behavioral assertion beside it
- `require.NotNil(t, x)` or `require.NoError(t, err)` where the real value is known and could be compared
- A `t.Run` block with no assertions
- A test that would still pass with the function body replaced by `return`

### How to measure

- `rg -n "NotNil\(|NoError\(|NotEmpty\(" internal e2e --glob '*_test.go'` and read each hit. Flag only where
  a specific value was available
- Never edit production code to prove a test is weak. This review shares its working tree with the
  maintainer and with other agents, and a half-restored file costs more than the finding is worth.
  Prove it by argument instead: quote the assertion, quote the production line it claims to cover,
  and name a second implementation of that line which the assertion would also accept. A named
  second implementation is the evidence. If you cannot name one, there is no finding

### Not a finding

- A regression test asserting that an error message text stays stable. The message is the contract
- `require.NotNil(t, x)` on a value whose only contract is presence

## 8. Mock quality

### What to check

- A mock that reimplements the logic under test
- A mock that encodes the expected output, so the assertion checks the fixture
- Every dependency mocked, leaving nothing real
- Mock setup much longer than the assertions

### How to measure

- Per test file, compare stub types and fake deps to assertions:
  `rg -c "mock|stub|fake|Stub" internal --glob '*_test.go'` against
  `rg -c "require\.|assert\.|t\.Fatal|t\.Error" internal --glob '*_test.go'`. A ratio above
  roughly 3:1 is worth reading. The ratio is a reading trigger, not a verdict
- For each candidate, name what real code the test still exercises. "Nothing" is the finding

### Not a finding

- Temp dirs and injected `Env` funcs in unit tests. Calling the real herdr binary is the hazard the
  `e2e/` harness controls
- Filesystem and HOME isolation in tests

## 9. Hard constraints without a pinning test

Every load error in `AGENTS.md` "Hard constraints" is a promise. A promise with no test is one
refactor away from silently disappearing.

### What to check

- Each constraint that says a construct "is a load error" has a test asserting the rejection
- Each cap in `internal/caps/` has a test asserting the failure names the source and the limit, and
  that it does not truncate
- Each denied herdr method fails at load with its invariant
- Placement rules, `when:` forms, `retry` restrictions, and `success_codes` each have at least one
  rejection test

### How to measure

- List the constraints from `AGENTS.md`. For each, grep the test suite for the error text:
  `rg -n "<distinctive words from the error>" internal e2e --glob '*_test.go'`
- `rg -n "ByteLimit|CaptureLimitError" internal/caps` and grep each name in `*_test.go`
- Report a constraint with no hit as High. This is a FIX when the assertion belongs in an existing
  test file, and an ADD only when a new file is unavoidable

### Not a finding

- A constraint the loader enforces where a loader test already covers the rejection path
  generically. Say which test

## 10. Suite shape

### What to check

- A test file that is a dumping ground rather than a suite. `internal/engine/runner_test.go` is the largest.
  Judge it by whether a maintainer can find the test for a given behavior, not by line count
- Duplicate tests asserting the same behavior in two files
- Helpers copied between test files
- Test names that do not say what breaks. `TestWorks` names nothing

### How to measure

- Shape metrics from Phase 0 give the sizes
- `rg -n "^func Test" internal --glob '*_test.go' | head -60` and judge whether the names form a readable map
- `rg -n "func Test(Works|Basic|Smoke)" internal e2e --glob '*_test.go'`

### Not a finding

- A large file with a clear `t.Run` structure whose names map to product surfaces

## 11. Determinism

### What to check

- A test depending on wall-clock time, ordering, network, real HOME, a real socket, or a real
  `herdr` binary outside the `e2e/` harness
- A test that only passes when it runs after another
- Sleeps standing in for a real wait condition

### How to measure

- `rg -n "time\.Now\(\)|time\.Sleep|rand\." internal e2e --glob '*_test.go'`
- `rg -n "os\.Getenv\(\"HOME\"\)|os\.UserHomeDir|HERDR_SOCKET" internal e2e --glob '*_test.go'` and check each against the
  temp-dir or injected env the test provides
- Phase 0 already ran the suite once. A second `go tool verify` (or `go test ./...` alone) catches order and state dependence
  between runs. Cite shared mutable state by `file:line` when you find it

### Not a finding

- A test that sets time explicitly to a fixed value
