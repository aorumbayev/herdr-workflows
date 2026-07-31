## Context

The prior runner appended completed steps and one terminal row to a shared `runs.jsonl`. That design did not persist active-step state or checkout identity, and concurrent trim rewrites could lose another process's append. This change replaces that shared log with per-run snapshots. Existing `runs.jsonl` files are ignored: new code neither reads, writes, migrates, nor deletes them. The workbench and picker present only snapshot history.

The picker must remain a static-titled 64×15 popup with one fixed six-row viewport. The workbench is an authenticated repository-scoped server, while the requested All view reads machine-wide plugin state. Run history is optional observability: its failure must not change workflow execution.

## Goals / Non-Goals

**Goals:**

- Persist active step, elapsed time, recorded outcomes, exact checkout root, and terminal status.
- Add a shallow picker Runs browser and one scrollable detail view.
- Add an accessible workbench list and selected-run inspector.
- Keep concurrent writers isolated and privacy constraints structural.
- Preserve current-worktree defaults while allowing explicit temporary machine-wide history.

**Non-Goals:**

- Cancellation, rerun, retry control, or workbench execution.
- Raw output, prompts, inputs, transcripts, environment, params, or pane captures.
- Automatic `.hwf` copying, repository-family scope, or cross-worktree synchronization.
- Audit-grade event sourcing, configurable retention, or migration or display of prior `runs.jsonl` data.

## Decisions

### Store one atomic snapshot per run

Each run owns `runs/<uuid>.json` under the private plugin state directory. The writer exclusively claims the path, keeps the complete state in memory, writes a same-directory temporary file, and renames it atomically. A later successful write repairs a missed earlier write.

A snapshot contains:

- version and full canonical lowercase UUID
- entry workflow name and `repo|global` source
- canonical checkout root
- start, heartbeat, and optional finish timestamps
- current step
- ordered recorded step outcomes
- terminal status
- private workflow returns

Each step contains phase (`main|recovery`), workflow path, local ordinal and total, optional step ID, action kind, safe display label, timing, and outcome. The array order is authoritative. wall-clock timestamps are display data.

A picker allocates the UUID before spawn and sends it through the private stdin launch payload. The child validates it and exclusively claims the snapshot. A direct CLI run allocates its UUID in the runner. UUID reuse fails the claim before execution.

Alternative considered: per-run JSONL events. Rejected because one owner does not need event replay, corruption recovery, sequence numbers, or terminal precedence logic.

### Treat history as optional observability

History initialization and snapshot writes never abort a workflow. The detached child sends one machine-readable launch acknowledgement through the existing observed stdout channel:

- snapshot claimed
- history unavailable
- launch rejected

The picker starts in local `STARTING` state. A successful claim moves it to attached `RUNNING`. unavailable history moves it to `RUNNING · HISTORY UNAVAILABLE` using ordinary progress lines. A spawn or claim failure remains a picker-local launch failure and is not presented as durable history.

### Define live state as heartbeat freshness

The snapshot writer updates `heartbeatAt` every five seconds. A non-terminal snapshot is active while the heartbeat is less than fifteen seconds old and stale afterward. The UI labels active as `RUNNING`. Stale is not failure and can return to running after a fresh heartbeat. `INTERRUPTED` means only a terminal coordination-loss record.

The heartbeat timer is unreferenced, stops before terminal persistence, and never triggers retention cleanup.

### Record only executed outcomes

Before dispatch, the runner writes `currentStep`. After outcome, it appends the safe outcome and clears `currentStep`. Skipped and launched steps are outcomes without dispatch waits. Entry recovery is one step with `phase: recovery`.

A parent `workflow:` step appears once, with child outcomes indented by workflow path. Child failure drives the parent wrapper outcome but produces one failure block. The projection does not invent names for steps that never started. it reports only the known remaining count for an entered workflow.

### Separate safe facts from precise detail

List projections contain only closed data: status, workflow identity, run ID, timing, progress, checkout root, action kind, step ID, exit code, Herdr method, and coordination state. Search covers these fields and safe labels, not failure explanation text.

The private snapshot may retain the runner's existing bounded failure explanation for the selected-run detail response. That explanation can contain tool-provided text, so it is never returned by list APIs, indexed for search, copied automatically, or exposed without the authenticated detail request. No stdout or stderr body is stored as a separate history field.

Existing credential-store ownership and mode checks protect the run directory and files. History validation must not strip ACLs or silently repair unsafe modes. a permission mismatch on the store or a snapshot file makes history unavailable rather than treating the record as missing. Authenticated page and run API responses use `Cache-Control: no-store`. Claim identity requires a resolvable realpath. soft canonicalization remains only for Current-scope lookup and deleted-root display.

### Scope by exact checkout root

Current matches the canonical active checkout root exactly and excludes sibling worktrees. All removes that predicate. Machine-wide scope is explicit and is never persisted across cold loads.

Prior `runs.jsonl` files remain on disk if present and are ignored. History list and detail use only retained snapshots under `runs/<uuid>.json`.

### Keep the TUI shallow

Tab switches Workflows and Runs only at their root browsers. Runs reuses the filter, six-row viewport, two-line selected summary, separator, and footer. `Ctrl+G` toggles Current and All. the stdin pre-handler must preserve raw `0x07`.

Row priority is status, progress, elapsed time, then workflow identity. All-scope location is omitted before a required field is clipped.

Enter replaces the root with one scrollable detail viewport. After final input, a launch opens this same view in `STARTING`. Terminal state remains visible. Escape returns to Runs and leaves an active child running. `w` opens the authenticated full-UUID workbench route.

### Keep two workbench filters

Runs provides a labeled native Location selection and one Search input. Location contains the current checkout, All folders, and roots present in retained snapshots. Search uses the run-history matching contract. no separate Status control is added.

The list and inspector form one desktop split view. Polling runs only while Runs is active and the document is visible. Each request has an abort or generation guard so a late response cannot replace another tab. Refresh preserves selection and focus and announces only a selected terminal transition.

### Deep-link without expanding edit authority

`run=<uuid>` selects an authenticated global record regardless of the cold Current default. Reload preserves that selection. Malformed, missing, and evicted IDs get distinct Back to runs states.

A foreign or deleted checkout remains inspectable. Open current workflow appears only when checkout root, recorded workflow source, and current workbench catalog resolve to the same editable workflow.

At narrow widths the UI shows either list or detail. Bare Runs opens list first. a deep link opens detail first with Back to runs.

### Use fixed retention

Terminal snapshots share the existing 512,000-byte target. Cleanup runs on run creation and terminal write, removes oldest terminal snapshots until within the target, and never removes active or stale non-terminal snapshots. If the newest terminal snapshot alone exceeds the target, it remains as the newest record until a later terminal snapshot makes it eligible for removal. List projection applies filters before the forty-run limit.

## Risks / Trade-offs

- [Heartbeat pauses during suspension] → Stale is explicitly non-terminal and reverses after a fresh write.
- [Failure explanation contains sensitive tool text] → Keep it private, detail-only, authenticated, non-searchable, and absent from list responses.
- [Machine-wide paths reveal project names] → Require explicit All, private ACLs, token authentication, no-store responses, and reset to Current.
- [Snapshot write fails] → Keep execution independent. the next atomic snapshot repairs state when possible and the attached picker reports history unavailable.
- [Picker or page complexity grows] → Put snapshot projection and TUI formatting outside existing monoliths. keep one viewport and two workbench controls.
- [Late polling response corrupts navigation] → Abort or generation-check every Runs request.
