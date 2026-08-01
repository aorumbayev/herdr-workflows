# Group A: Code and Tests

The reader is one maintainer holding the whole repository in their head. Your job is to shrink what
they must hold, and to check that the tests would notice if the code broke.

Your brief is wide because this repository runs three review agents, not seven. Work the sections in order
and do not stop early.

**Boundary:** a rule with no enforcing site anywhere is Group B. Duplication of _code_ is yours, and
duplication of a _rule_ across code and prose is Group B. Security validation is Group C, and you
never propose deleting it.

**Read first:** `AGENTS.md` sections "Layout", "Hard constraints" (Splitting, Comments), and "Code
style", then `test/setup.ts`. The Layout table is the intended mental model. `test/setup.ts`
quarantines real `herdr` and `hwf` and isolates HOME, config, and socket env, so a test that escapes
it can pass locally and fail in CI.

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

- Quote `npm run verify:file-length` for any `src/**/*.ts` near the 2,500-line cap (`*.generated.ts`
  exempt)
- `npm run verify:lint` reports `eslint/complexity`, `max-depth`, and `max-nested-callbacks` from
  `.oxlintrc.json`. Those are findings in the function, not in the file. `.oxlintrc.json` turns
  `max-nested-callbacks` off under `test/`, so that gate does not cover the suite
- `git log --diff-filter=A --name-only --oneline -20 -- src` for recently added files. For each,
  find its callers with `rg -n "from \"\./<name>\"|from \"\.\./<name>\""`. One caller and no test of
  its own means the split bought nothing

### Not a finding

- A file that `verify:file-length` or `eslint/complexity` fails on today. Shrinking it is required,
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
  `rg -n "\b<symbol>\b" src test --type ts | grep -v "<defining file>" | wc -l`
- For an option, grep for the option name and check whether any caller passes a non-default value
- `npm run verify:unused-code` (knip) already catches unreachable exports. Quote its output rather
  than re-deriving it. What knip cannot see is a symbol that _is_ reached but only once and adds no
  meaning — that is your target

### Not a finding

- A single implementation behind an interface that a test double also implements. The test is the
  second user
- Zod schemas and their inferred types. One schema, one type, by design

## 3. Duplication

### What to check

- The same logic in two places, where a fix must be applied twice
- Two code paths that implement one rule, such as validation in the loader and again in the web
  endpoint
- Copy-adapted helpers that differ only in a literal

### How to measure

- `npm run verify:duplicate-code` (jscpd) is the oracle for textual duplication. Quote it
- jscpd cannot see semantic duplication. For each hard constraint in `AGENTS.md`, grep for its
  error text or its rule name across `src/` and count the enforcing sites. More than one enforcing
  site for one rule is a finding unless the second is a deliberate defense in depth that a comment
  or test names

### Not a finding

- Generated files. `src/herdr-methods.generated.ts` and
  `docs/.vitepress/theme/examples.generated.ts` are outputs
- Test fixtures repeating shape on purpose

## 4. Dead code and dead flexibility

### What to check

- Exports nothing imports
- Branches no input can reach, including a `when:` form or CLI flag no surface produces
- Error paths for conditions the caller already rejected

### How to measure

- `npm run verify:unused-code` for exports
- For an unreachable branch, trace backward to the entry point in `src/cli.ts`, `src/picker.ts`, or
  `src/workbench.ts`. If no entry point can produce the input, quote the entry-point line as evidence
- A gate whose scope makes it impossible to fire is the same defect in the tooling. That one belongs
  to Group B, which audits the gates

### Not a finding

- Defensive validation at a trust boundary. Never delete input validation to reduce lines. See
  `criteria-risk.md`

## 5. Comments

Read the "Comments" constraint in `AGENTS.md`. `verify:comments --pushback` fails a comment block
over two lines. JSDoc is exempt, and so is a block whose first line starts `context:`, which means a
durable fact the code cannot express and which pages a human for approval.

### What to check

- Comments restating the next line
- Section banners and file headers that add no information
- A stale comment describing behavior the code no longer has
- A `context:` block that does not carry a durable fact, so it spends the escape hatch on narration
- A comment padded to fit under the two-line gate rather than deleted

### How to measure

- Quote `npm run verify:comments` output. It already reports what it flags
- `rg -n "context:" src` and read each block. Judge whether the code could express the fact instead
- For stale comments the gate cannot judge, read the comment and the code beneath it and quote both

### Not a finding

- A comment naming a non-obvious constraint, an upstream bug, or a deliberate ceiling

## 6. The mental model

### What to check

- One abstraction loads and validates workflows, one runs them, one per step type. Verify
  `src/workflow/` and `src/engine.ts` still hold that shape
- A concept that lives in two folders
- A folder holding one file with no sibling planned
- `AGENTS.md` Layout rows that name a path that no longer exists, or paths under `src/` with no row

### How to measure

- `ls src/*.ts src/*/` against the Layout table in `AGENTS.md`, row by row. A row that names files
  the directory no longer holds is drift in the table. A file with no row is drift in the code
- The same listing shows single-file folders

## 7. Tests that cannot fail

Coverage percentage is not the question. The question is whether a test can fail when the product
breaks.

### What to check

- An assertion that restates the implementation, such as comparing a constant to the same imported
  constant
- A test whose only assertion is that a mock was called
- A snapshot with no behavioral assertion beside it
- `expect(x).toBeTruthy()` or `toBeDefined()` where the real value is known and could be compared
- A `describe` block with no `it`
- A test that would still pass with the function body replaced by `return`

### How to measure

- `rg -n "toBeTruthy\(\)|toBeDefined\(\)|not\.toThrow\(\)" test` and read each hit. Flag only where
  a specific value was available
- `rg -n "toMatchSnapshot|toMatchInlineSnapshot" test`
- Never edit `src/` or `test/` to prove a test is weak. This review shares its working tree with the
  maintainer and with other agents, and a half-restored file costs more than the finding is worth.
  Prove it by argument instead: quote the assertion, quote the production line it claims to cover,
  and name a second implementation of that line which the assertion would also accept. A named
  second implementation is the evidence. If you cannot name one, there is no finding

### Not a finding

- A regression test asserting that an error message text stays stable. The message is the contract
- `toBeDefined()` on a value whose only contract is presence

## 8. Mock quality

### What to check

- A mock that reimplements the logic under test
- A mock that encodes the expected output, so the assertion checks the fixture
- Every dependency mocked, leaving nothing real
- Mock setup much longer than the assertions

### How to measure

- Per test file, compare setup to assertions:
  `rg -c "mock|spyOn|stub" test/<file>` against `rg -c "expect\(" test/<file>`. A ratio above
  roughly 3:1 is worth reading. The ratio is a reading trigger, not a verdict
- For each candidate, name what real code the test still exercises. "Nothing" is the finding

### Not a finding

- The `test/setup.ts` quarantine of `herdr` and `hwf`. Calling the real binary is the hazard it
  exists to prevent
- Filesystem and HOME isolation

## 9. Hard constraints without a pinning test

Every load error in `AGENTS.md` "Hard constraints" is a promise. A promise with no test is one
refactor away from silently disappearing.

### What to check

- Each constraint that says a construct "is a load error" has a test asserting the rejection
- Each cap in `src/context.ts` has a test asserting the failure names the source and the limit, and
  that it does not truncate
- Each denied herdr method fails at load with its invariant
- Placement rules, `when:` forms, `retry` restrictions, and `success_codes` each have at least one
  rejection test

### How to measure

- List the constraints from `AGENTS.md`. For each, grep the test suite for the error text:
  `rg -n "<distinctive words from the error>" test`
- `rg -n "export const [A-Z_]+_(LIMIT|BYTE)" src/context.ts` and grep each name in `test`
- Report a constraint with no hit as High. This is a FIX when the assertion belongs in an existing
  test file, and an ADD only when a new file is unavoidable

### Not a finding

- A constraint the Zod schema enforces where a schema-level test already covers the rejection path
  generically. Say which test

## 10. Suite shape

### What to check

- A test file that is a dumping ground rather than a suite. `test/engine/runner.test.ts` is the largest.
  Judge it by whether a maintainer can find the test for a given behavior, not by line count
- Duplicate tests asserting the same behavior in two files
- Helpers copied between test files
- Test names that do not say what breaks. `it("works")` names nothing

### How to measure

- Shape metrics from Phase 0 give the sizes
- `rg -n "^\s*(it|test)\(" test/<file> | head -60` and judge whether the names form a readable map
- `rg -n "it\(\"works|it\(\"should work|test\(\"basic" test`

### Not a finding

- A large file with a clear `describe` structure whose names map to product surfaces

## 11. Determinism

### What to check

- A test depending on wall-clock time, ordering, network, real HOME, a real socket, or a real
  `herdr` binary
- A test that only passes when it runs after another
- Sleeps standing in for a real wait condition

### How to measure

- `rg -n "Date\.now\(\)|new Date\(\)|Math\.random\(\)|setTimeout|sleep" test`
- `rg -n "process\.env\.HOME|os\.homedir|HERDR_SOCKET|fetch\(" test` and check each against the
  isolation `test/setup.ts` provides
- Phase 0 already ran the suite once. A second `bun test ./test` catches order and state dependence
  between runs, which is the cheap half. Bun runs files in a stable order, so it does not catch
  order dependence within a run — for that, cite the shared mutable state by `file:line`

### Not a finding

- A test that sets time explicitly to a fixed value
