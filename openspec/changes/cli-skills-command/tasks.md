# Tasks: cli-skills-command

Run `bun test ./test` and `CI=1 npm run verify` after every task.

- [x] 1.1 Add `src/skills.ts` embedding both bundled skills (`herdr-workflow-create`, `herdr-workflow-upgrade`) as text with a name/description registry and show formatting. Add `src/skill-text.d.ts` ambient declarations.
- [x] 1.2 Register the `skills` group in `src/cli.ts` with nested `list` and `show <name>`; unknown names fail nonzero naming the available skills.
- [x] 1.3 Add `test/cli/skills.test.ts`: list prints both skills with descriptions, show prints file-path headers and contents for each skill, unknown name fails.
- [x] 1.4 Verify the compiled path: `bun run build && ./bin/herdr-workflows skills list` and `skills show herdr-workflow-upgrade` print the embedded text without a Herdr connection.
