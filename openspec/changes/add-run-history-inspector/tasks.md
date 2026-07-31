## 1. Atomic run snapshots

- [x] 1.1 Define versioned private snapshot, step outcome, failure fact, list projection, and detail projection types outside `src/runlog.ts`.
- [x] 1.2 Implement exclusive UUID claims and complete-state same-directory temporary-write plus atomic-rename replacement under credential-store ACL assertions.
- [x] 1.3 Implement five-second heartbeat writes and active, stale, succeeded, failed, and interrupted projection with terminal precedence.
- [x] 1.4 Implement exact-root, explicit-root, All, text, and status predicates before newest-first sorting and the forty-result limit.
- [x] 1.5 Implement fixed 512,000-byte terminal retention on creation and finalization. preserve non-terminal snapshots and the newest oversized terminal snapshot.
- [x] 1.6 Ignore any prior `runs.jsonl` on disk. neither read, write, migrate, nor delete it.
- [x] 1.7 Test exclusive claims, atomic recovery after a missed write, concurrent runs, ACL rejection, heartbeat boundaries, terminal precedence, filter-before-limit, retention, and malformed snapshots.

## 2. Runner lifecycle integration

- [x] 2.1 Generate a full UUID after workflow load or validate and exclusively claim the picker's private launch UUID before the first step.
- [x] 2.2 Add the machine-readable launch acknowledgement for claimed, unavailable-history, and rejected states without exposing it as workflow output.
- [x] 2.3 Write current-step state before dispatch and append safe ordered outcomes afterward for main, recovery, skipped, launched, tolerated-failure, hard-failure, nested-workflow, and coordination-interruption paths.
- [x] 2.4 Finalize success, accumulated tolerated failure, hard failure, recovery failure, and recorded interruption while preserving private workflow returns.
- [x] 2.5 Stop the unreferenced heartbeat before terminal persistence and keep every history failure independent from workflow execution.
- [x] 2.6 Test fast completion, failures before dispatch, nested workflow grouping, known remaining counts, stale recovery, unavailable storage, snapshot collision, and failure-detail privacy boundaries.

## 3. Authenticated run API and routes

- [x] 3.1 Add authenticated list and full-UUID detail endpoints with allowlisted projections, explicit location filters, structured invalid/missing/expired states, and `Cache-Control: no-store`.
- [x] 3.2 Extend route parsing and URL generation for `run=<uuid>` without accepting displayed prefixes.
- [x] 3.3 Restrict Open current workflow metadata to exact-root editable catalog matches. keep foreign and deleted-root records inspectable.
- [x] 3.4 Test unauthorized access, unsafe storage, no-store headers, foreign deep links, deleted roots, output exclusion, and malformed UUIDs.

## 4. Picker Runs browser

- [x] 4.1 Extract run-row and detail formatting so the picker owns navigation state but not snapshot projection or string layout.
- [x] 4.2 Add Tab-switched Workflow and Runs root modes with preserved per-root filter and selection state.
- [x] 4.3 Reuse the fixed six-row viewport and footer for Current and All history, safe filtering, textual status, row-priority truncation, and distinct empty states.
- [x] 4.4 Preserve raw `0x07` and bind `Ctrl+G` to the temporary Current and All scope without changing printable filter input.
- [x] 4.5 Add one scrollable detail mode for active, stale, terminal, unavailable, nested, and remaining-count states.
- [x] 4.6 Open `STARTING` detail after final input, consume the launch acknowledgement, keep terminal results visible, and detach observation without stopping an active child on Escape.
- [x] 4.7 Add `w` handoff with the complete UUID and a bounded in-place launch error.
- [x] 4.8 Test modal Tab behavior, six-row scrolling, narrow truncation, `Ctrl+G`, local launch failure, history unavailable, fast completion, Escape restoration, and detached handoff.

## 5. Workbench split inspector

- [x] 5.1 Replace flat Runs cards with labeled native Location and Search controls, a newest-first list, and one selected-run inspector.
- [x] 5.2 Render textual statuses, active step, elapsed time, nested outcomes, known remaining counts, detail-only failure explanation, exact root, and conditional Open current workflow.
- [x] 5.3 Poll only while Runs and the document are visible. abort or generation-check requests and preserve selection, focus, list position, and inspector scroll.
- [x] 5.4 Support valid, malformed, missing, and expired full-UUID routes plus foreign-root cold selection.
- [x] 5.5 Add one-pane narrow navigation, visible focus, keyboard traversal, and selected-terminal-transition announcements through the existing polite live region.
- [x] 5.6 Test composed filters, Current reset, guarded stale responses, stable refresh, narrow deep links, foreign and deleted roots, and every empty or degraded state.

## 6. Documentation and verification

- [x] 6.1 Document Runs navigation, heartbeat-defined running state, exact-checkout Current scope, temporary All scope, deep links, retention, and the failure-detail privacy boundary.
- [x] 6.2 Run focused tests, `bun test ./test`, `npm run verify`, `bun run docs:build`, and strict OpenSpec validation after removing prior shared-log compatibility.
