# Group B: Truth and Enforcement

Three artifacts describe one product. `openspec/specs/*/spec.md` is the spec of record, `src/` is the
truth about behavior, `docs/` is the promise to users. You find where they disagree and name **which
one is wrong**. Then you check whether the rules they state are enforced by a machine or only
remembered.

Your brief is wide because this repository runs three review agents, not seven. Work the sections in order
and do not stop early.

**Boundary:** code shape, duplication of code, and test power are Group A. Security holes are Group
C. You own truth, prose, and enforcement.

**Read first:** `AGENTS.md` "Hard constraints", `CONTRIBUTING.md` "OpenSpec" and "Documentation
style". Prose follows Simplified Technical English: active voice, one term per concept, short
sentences, no marketing filler, no semicolons, American spelling. Exact technical contracts and
examples stay unchanged.

## 1. Docs against code

### What to check

- A capability claim in `README.md`, `docs/guide.md`, `docs/reference.md`, `docs/install.md`, or
  `docs/surfaces.md` that the code does not implement
- Two pages that state the same fact differently. One of them is wrong
- A command, flag, path, env var, or key documented but absent from `src/`
- A version, minimum herdr version, or format string that differs between docs and
  `herdr-plugin.toml` or `package.json`

### How to measure

- For each claim, grep the implementing surface and cite it: `rg -n "<flag|command|key>" src`
- For cross-page contradictions, grep the fact across `README.md docs/*.md AGENTS.md`. When two
  pages disagree, read the code and state the wrong line by `file:line`
- `rg -n "0\.[0-9]+\.[0-9]+|v1alpha[0-9]+" README.md docs/*.md herdr-plugin.toml package.json` for
  version drift

### Not a finding

- Docs describing a documented future step already tracked in an OpenSpec change, provided the doc
  marks it as not yet available

## 2. Spec against code

### What to check

- A spec requirement the code contradicts, meaning `src/` does something the spec says it does not
- Behavior in `src/` that no main spec covers
- A capability directory under `openspec/specs/` whose subject no longer exists

### How to measure

- `ls openspec/specs/` for the capability list. For each,
  `rg -n "MUST|SHALL" openspec/specs/<cap>/spec.md`
- For each requirement, read the implementing code and say whether it agrees. Find it by the
  requirement's own words: `rg -n "<distinctive phrase from the requirement>" src`. A requirement
  with no site at all is section 9's finding. A site that behaves differently is this section's
- `openspec validate --all --strict` result comes from Phase 0. Quote it. Do not re-run

### Not a finding

- A requirement enforced by a Zod schema rather than an explicit branch. The schema is the
  enforcing site

## 3. Generated artifacts

### What to check

- A generated file edited by hand
- A generator whose output no longer matches its source
- A generated file with no regeneration command named in `AGENTS.md`

### How to measure

- Phase 0 already ran `bun run schema && bun run examples` and diffed. Quote the diff. Non-empty is
  the finding
- `rg -l "generated" src docs/.vitepress/theme` and check each hit against the `AGENTS.md` command
  list
- `bun run schema:herdr` is release-time only and must not run from the plugin build. Confirm no
  build or install path invokes it:
  `rg -n "schema:herdr|herdr api schema" package.json herdr-plugin.toml scripts`

### Not a finding

- A generated file that differs only in formatting when the formatter version changed. State that
  explicitly and quote the two versions

## 4. herdr runtime claims

### What to check

- Any statement about herdr behavior with no reference path behind it
- A herdr method, param, or event named in `src/`, docs, or a spec that the pinned reference version
  does not define
- A pinned version in `AGENTS.md` and `CONTRIBUTING.md` that differs from the manifest

### How to measure

- The reference checkout is `.agents/references/herdr/docs/versions/<version>/`. If absent, report
  "Not measured" and stop this section. Do not infer from memory
- `rg -n "<method name>" .agents/references/herdr/docs/versions/<version>/` for each method in
  `schemas/herdr-api.schema.json` and `src/host.ts`
- `rg -n "0\.7\.[0-9]+" AGENTS.md CONTRIBUTING.md README.md herdr-plugin.toml docs/*.md`

### Not a finding

- A method the denylist protects. Its presence in the policy is the point

## 5. Schema, reference, and examples

### What to check

- A cross-field rule stated in `docs/workflow.schema.json` rather than in the loader
- A loader refinement with no counterpart in `docs/reference.md`
- The reference page documenting a key the loader rejects, or missing a key it accepts
- A YAML snippet in `docs/` that cannot load. A snippet that cannot load teaches a false contract
- A snippet retyped by hand where a generator exists

### How to measure

- `AGENTS.md` states cross-field rules live in the loader. Grep the schema for conditional keywords:
  `rg -n "allOf|anyOf|if\"|dependentRequired" docs/workflow.schema.json`
- Load every file under `examples/` through the real loader rather than reading it:
  `bun test ./test -t 'example'`, or run `hwf` against the file when a built binary exists. Quote
  the result
- `rg -n '```yaml' -A20 docs/*.md README.md` and compare each snippet's keys against the Zod schema
  in `src/workflow/grammar.ts`. Cite both sides
- For key coverage, list `.strict()` object keys in `src/workflow/grammar.ts` and grep each in
  `docs/reference.md`

### Not a finding

- A deliberately invalid snippet that the surrounding prose labels as invalid

## 6. Docs length and repetition

### What to check

- One fact explained on more than one page. Pick the home page, link from the others
- A section a reader can skip with no loss. Delete it
- A table that restates the prose beside it
- Ceremony openings: "In this section we will", "It is important to note that", "As mentioned above"
- Hedging that carries no information: "generally", "typically", "should usually"
- A page whose first screen does not tell the reader what they can now do

### How to measure

- `wc -l README.md CONTRIBUTING.md AGENTS.md docs/*.md` and read every page top to bottom. Judgment
  is the instrument here. Cite the lines you would delete
- For a repeated fact, grep the distinctive phrase across
  `README.md docs/*.md AGENTS.md CONTRIBUTING.md` and cite each hit
- `rg -n "important to note|in this section|as mentioned|it should be noted|please note" README.md CONTRIBUTING.md docs/*.md`
- `rg -n "[a-z]; [a-z]" README.md CONTRIBUTING.md AGENTS.md docs/*.md` for semicolons in prose. The
  narrow pattern skips most code and still finds the real ones. Check each hit is not inside a fence

### Not a finding

- `AGENTS.md` "Hard constraints" repeating a rule the code enforces. That file exists to repeat
  things agents get wrong. Density there is the feature
- Reference material that is long because the contract is long

## 7. The two reading paths

A user reads `README.md` and `docs/`. A contributor reads `CONTRIBUTING.md` and `AGENTS.md`. Walk
both in order and name the first step that fails or that needs knowledge the page did not give.

### What to check

- A first-time user can install, run one workflow, and understand what happened, from `README.md`
  and `docs/install.md` alone
- Every command in a doc is copy-pasteable and correct on macOS and Linux
- Windows readers learn early that WSL2 is the only supported path
- Errors a user hits first are documented with the fix
- A contributor can clone, install, build, test, change one thing, verify, and open a pull request
  from `CONTRIBUTING.md` and `AGENTS.md` alone
- Commands in `AGENTS.md` "Commands" all exist in `package.json`
- OpenSpec instructions match the installed CLI's actual commands

### How to measure

- `rg -n '```bash' -A5 README.md docs/install.md` and check each command against `package.json`
  scripts and `src/cli.ts`
- `rg -in "windows|wsl" README.md docs/*.md` and report where in the reading order it appears
- `jq -r '.scripts | keys[]' package.json` against the command block in `AGENTS.md`
- `openspec validate --help` and `openspec --help` against the commands `CONTRIBUTING.md` names
- Run the check commands `CONTRIBUTING.md` lists. Phase 0 covers most. Quote any that fail

### Not a finding

- A step needing a real herdr install. That is the product, not a doc gap
- A missing step the harness supplies, provided the doc says so

## 8. Stray and orphaned docs

### What to check

- Files under `docs/` that no page links and the site does not build
- Vestigial directories from past experiments
- Committed artifacts that belong in `.gitignore`

### How to measure

- `ls docs/` and `find docs -maxdepth 1 -type d`. For each, grep for references:
  `rg -n "<dirname>" docs/.vitepress/config.mts docs/*.md`
- Compare against `docs/.vitepress/config.mts` nav and sidebar entries
- `bun run docs:build` output from Phase 0 reports dead links. Quote it

### Not a finding

- `docs/public/` and `docs/assets/`, which VitePress consumes without a link

## 9. Prose rules with no enforcing site

A rule that only asks is a wish.

### What to check

Take every constraint in `AGENTS.md` "Hard constraints" and every `MUST` in `openspec/specs/`. For
each, find the site that rejects a violation, then rank it:

1. The type system rejects it, so it cannot compile
2. The loader or schema rejects it at load
3. A verifyx check or CI job fails
4. A git hook catches it
5. Nothing. Prose only

### How to measure

- For each rule, grep for its error text, then its rule name, then the concept:
  `rg -n "<distinctive phrase>" src test .githooks .github`
- Report level 5 as High and name the cheapest available upgrade. Prefer a refinement in an existing
  Zod schema or one assertion in an existing test file over any new file
- Rank the enforcement, then stop. Whether the rule also has a test pinning its message is Group A's
  finding
- Some rules are unenforceable by a machine, such as "question speculative need". Say so plainly and
  do not propose a check. Naming it as unenforceable is the finding's value

### Not a finding

- A rule that exists to steer agent behavior and has no code counterpart by nature, once you have
  said which one it is. Do not propose lint rules for judgment

## 10. Checks that cannot fire

A check that cannot fire is worse than no check, because it reports safety it does not provide.

### What to check

- A verifyx check whose configured root does not contain the pattern it looks for
- A check restricted to a glob that matches nothing
- A `verify.config.json` ignore broad enough to disable the check
- A hook that is not installed on a fresh clone

### How to measure

- Read every `verify:*` script in `package.json`. For each, resolve its root or glob and confirm the
  pattern exists there. `verify:hardcoded-colors` runs twice, once at the default root and once with
  `--root docs/.vitepress/theme`. Confirm both roots still hold color literals, and that no third
  place does
- For each `verify.config.json` ignore, count what it excludes: `rg -l "<pattern>" | wc -l`. An
  ignore excluding the only files the check would ever flag disables the check
- `git config core.hooksPath` and the `prepare` script. A hook path set only by a script a
  contributor may never run is a gap. Say whether `bun install` runs it

### Not a finding

- An ignore covering generated files, provided the generator is itself checked

## 11. Gate parity, thresholds, and governance drift

### What to check

- A check that runs locally but not in CI, or in CI but not locally
- A check that runs on one operating system when the product supports two
- A CI job that blocks a pull request but appears in no contributor-facing list
- A threshold or ignore that moved in the loosening direction with no reason recorded
- `CLAUDE.md` and `AGENTS.md` diverging into two real files
- One rule stated in three places with three wordings
- Branch protection that `CONTRIBUTING.md` expects but nothing configures

### How to measure

- Read `.github/workflows/verify.yml`, `.githooks/pre-commit`, and the `CONTRIBUTING.md` "Checks"
  block. Build a three-column table: local, pre-commit, CI. Every asymmetry is either intentional or
  a finding, and you must say which. Cite `file:line` on both sides
- Count the jobs in `verify.yml` and confirm `AGENTS.md` and `CONTRIBUTING.md` name every one
- Check these by name, because they are cheap to lose: tests run on two operating systems while
  `npm run verify` runs on one, pre-commit runs verify without tests, and `openspec validate --all
--strict` appears in `CONTRIBUTING.md` — confirm whether any CI job runs it
- The tunable values are few: the 2,500-line cap in `verify:file-length`, the `eslint/complexity`
  ceiling in `.oxlintrc.json`, `--max-warnings` on `verify:lint`, and the ignore lists in
  `verify.config.json` and `knip.json`. Note the direction before you judge one: raising the
  file-length or cyclomatic ceiling loosens the gate. Enumerate the values, then run
  `git log -p -- .oxlintrc.json knip.json package.json scripts/verify-file-length.ts | rg -n "2500|complexity|max-warnings|ignore"`
  and name the commit behind each. No reason in the message is a finding, and the fix is one line of
  prose
- `ls -la CLAUDE.md AGENTS.md` — expect a symlink. Two regular files is the finding
- Read `.githooks/commit-msg` and `.githooks/pre-commit` and name what each blocks. `AGENTS.md`
  already states the trailer strip is a backstop, not the rule. Confirm the primary statement exists
- `gh api repos/:owner/:repo/branches/main/protection 2>/dev/null` when `gh` is authenticated.
  Report "Not measured" otherwise

### Not a finding

- Deliberate speed tradeoffs the docs already state, such as pre-commit skipping tests
- A threshold set at the current ceiling with the ceiling named in `AGENTS.md`
