# /goal Infrastructure TODO

Temporary local tracker for remaining /goal subagent architecture work. Keep this file untracked unless explicitly promoted to durable repo docs.

## How To Use This File

Agents should treat each `TASK-*` section as an independent work item.

Rules:

1. Pick the first task with `Status: TODO` unless goal state says otherwise.
2. Work only one task per autonomous continuation unless explicitly instructed.
3. A task is done only when every acceptance check is satisfied with concrete evidence.
4. When done, change `Status: TODO` to `Status: DONE` and fill `Done Evidence`.
5. Do not revisit `Status: DONE` tasks unless a later task explicitly invalidates them.
6. Keep `GOALS-TODO.md` and `GOAL_SUBAGENT_ARCHITECTURE.md` untracked unless explicitly instructed.

Status values:

- `TODO` — not started or not yet complete.
- `IN_PROGRESS` — useful if stopping mid-task.
- `DONE` — acceptance checks satisfied; do not revisit.
- `DEFERRED` — intentionally postponed with reason/evidence.

## Current Baseline

- Shared `agent-runner.ts` is used by `/goal` and generic `subagent`.
- Subagent sessions are persisted by default and session files are referenced from goal iterations.
- Goal state has bounded `iterations[]` with compact report/session refs.
- `/goal` worker, reviewer, observer, and researcher use schema-v1 `GoalAgentReport` JSON.
- Goal reviews store structured evidence and per-criterion assessments; manual `goal_review` uses the same core reviewer merge path.
- Role checkpoints persist bounded completed/failed role outcomes and session references before a continuation proceeds or retries.
- `get_goal` is reserved for explicit goal work; complete/cleared last goals return a short `NO_ACTIVE_GOAL` response while durable history remains available.
- Basic report validators, completion-readiness checks, and focused unit tests exist.

---

## TASK-001: Structured Context Packet

Status: DONE

### Objective

Replace prose-heavy worker/reviewer context with an explicit context packet that is easy for subagents to consume and easy for the orchestrator to audit.

### Acceptance Checks

- [x] A context packet type/shape exists for delegated goal agents.
- [x] Worker prompt includes the context packet as structured JSON.
- [x] Reviewer prompt includes the context packet or equivalent structured goal state.
- [x] Packet includes goal metadata, criteria, summary/checklist, facts, assumptions, risks, blockers, evidence, latest review, scaffold id/body/policy, requested role/action, and report contract hint.
- [x] Relevant tests pass.

### Done Evidence

- Added `buildGoalContextPacket` in `goal-core.mjs` with schemaVersion, goal metadata, criteria, summary/checklist, facts, assumptions, risks, blockers, evidence, latest review, scaffold body/policy, requested role/action, and report contract hint.
- Updated worker and reviewer prompts in `goal.ts` to include the packet as authoritative structured JSON while retaining a secondary human-readable snapshot.
- Added `tests/goal-core.test.mjs` coverage for packet shape.
- Validation: `node --test tests/*.test.mjs` passed (18 tests).

---

## TASK-002: Merge Engine Tests and Hardening

Status: DONE

### Objective

Make report-to-goal-state merging easier to test and safer to evolve.

### Acceptance Checks

- [x] Report merge behavior is covered by pure unit tests.
- [x] Tests cover proposed facts/assumptions/risks/blockers/evidence.
- [x] Tests cover criteria add/update/pass with evidence.
- [x] Tests prove worker `ready_for_review` does not complete the goal by itself.
- [x] Tests cover reviewer verdict plus readiness interaction.
- [x] Tests cover waiting policy and blocked policy.
- [x] Merge logic is extracted from `goal.ts` into `goal-core.mjs` where practical.
- [x] Relevant tests pass.

### Done Evidence

- Added pure merge helpers in `goal-core.mjs`: `applyGoalAgentReport`, `applyGoalReviewerReport`, `criteriaInputsFromGoalAgentReport`, and `goalAgentReportEffectiveOutcome`.
- Updated `goal.ts` to use core merge helpers while keeping secret scanning in the orchestrator wrapper.
- Added `tests/goal-core.test.mjs` coverage for durable proposed state merges, criteria add/update/pass evidence, worker readiness without direct completion, reviewer verdict/readiness completion interaction, and waiting/blocked policy handling.
- Validation: `node --test tests/*.test.mjs` passed (23 tests).

---

## TASK-003: Scaffold Workflow Selection

Status: DONE

### Objective

Use scaffold `workflow` metadata to choose role plans instead of treating all continuations as worker-shaped.

### Acceptance Checks

- [x] Orchestrator reads scaffold `workflow` and selects a role plan.
- [x] Supported initial workflows: `worker`, `worker-reviewer`, `observer-worker`, `research-worker`, `operations`.
- [x] Unknown workflow falls back safely or reports a clear error.
- [x] Lifecycle authority remains orchestrator-owned regardless of scaffold.
- [x] Workflow selection has unit tests or a focused smoke test.
- [x] Relevant tests pass.

### Done Evidence

- Added `selectGoalWorkflowPlan` in `goal-core.mjs` for scaffold-driven workflow selection with support for `worker`, `worker-reviewer`, `observer-worker`, `research-worker`, and `operations`, plus safe fallback for unknown workflow metadata.
- Threaded selected workflow plans into delegated worker prompts/context packets so continuations receive workflow roles, requested worker action, operating-cycle hint, and explicit orchestrator lifecycle authority.
- Updated bundled operations scaffold metadata to use `workflow: operations`.
- Added focused unit coverage in `tests/goal-core.test.mjs` for supported workflows, operations behavior, fallback behavior, and lifecycle authority.
- Validation: `node --test tests/*.test.mjs` passed (24 tests).

---

## TASK-004: Observer Role

Status: DONE

### Objective

Add an observer role for stale external/repo/runtime state inspection without major mutation.

### Acceptance Checks

- [x] Observer agent prompt exists.
- [x] Observer uses schema-v1 report envelope.
- [x] Observer role is integrated into at least one workflow path.
- [x] Observer reports current state, bottlenecks, opportunities, risks, evidence, and recommended actions using structured fields or agreed envelope extensions.
- [x] Observer is instructed not to make major changes.
- [x] Relevant tests pass or limitations are recorded.

### Done Evidence

- Added `agents/goal-observer.md` with a schema-v1 observer report contract focused on current state, bottlenecks, opportunities, risks, evidence, and recommended worker action while explicitly forbidding major mutations.
- Added observer report validation hardening in `goal-core.mjs` so observer reports cannot claim completion/review readiness and progress observations require inspection evidence.
- Added `priorRoleReports` to goal context packets so observer output can be passed to the worker.
- Integrated `observer-worker` workflow execution in `goal.ts`: observer runs first with read-only tools, its report is conservatively merged, worker receives the observer report, and iteration/session refs include the observer.
- Added focused tests for observer report validation and observer-to-worker context handoff.
- Validation: `node --test tests/*.test.mjs` passed (27 tests); `git diff --check` and `node --check goal-core.mjs`/`node --check goal.ts` passed.

---

## TASK-005: Researcher Role

Status: DONE

### Objective

Add a researcher role for strategy/API/domain uncertainty before worker execution.

### Acceptance Checks

- [x] Researcher agent prompt exists.
- [x] Researcher uses schema-v1 report envelope.
- [x] Researcher role is integrated into at least one workflow path.
- [x] Researcher can report findings, open questions, evidence, confidence, and recommended doctrine/state updates.
- [x] Researcher is instructed not to mutate project state except through its report.
- [x] Relevant tests pass or limitations are recorded.

### Done Evidence

- Added `agents/goal-researcher.md` with a schema-v1 researcher report contract focused on findings, open questions, evidence, confidence, recommended doctrine/state updates, and recommended worker action while explicitly forbidding project mutation outside the report.
- Added researcher report validation in `goal-core.mjs` so researcher reports cannot claim completion/review readiness and progress reports require research evidence; optional `openQuestions` and `recommendedDoctrine` fields are validated.
- Integrated `research-worker` workflow execution in `goal.ts`: researcher runs before the worker, its report is conservatively merged, worker receives the researcher report via `priorRoleReports`, and iteration/session refs include the researcher.
- Added focused tests for researcher report validation and prior role handoff.
- Validation: `node --test tests/*.test.mjs` passed (29 tests); `node --check goal-core.mjs`/`node --check goal.ts` passed.

---

## TASK-006: Scheduled Strategic Reviews

Status: DONE

### Objective

Clarify and implement scheduled reviews so `reviewEvery` does not rely on worker-shaped strategic review prompts.

### Acceptance Checks

- [x] Decision recorded: scheduled reviews use reviewer role or a distinct strategic-review report flavor.
- [x] `reviewEvery` path follows that decision.
- [x] Scheduled reviews do not imply terminal readiness unless explicitly warranted.
- [x] Review records distinguish strategic review from terminal completion review if needed.
- [x] Relevant tests pass.

### Done Evidence

- Decision: scheduled `reviewEvery` reviews now use the reviewer role with a scheduled strategic-review prompt/report, not the worker prompt with a `strategic_review` action.
- Added `scheduledReviewDue`, `strategicReviewPrompt`, and `runScheduledStrategicReview` in `goal.ts`; due scheduled reviews run as reviewer-only iterations and then queue normal continuation if still active.
- Added review `kind` (`strategic` vs `terminal`) and core handling so strategic reviews are recorded distinctly and cannot complete the goal by themselves.
- Updated completion readiness to require the latest terminal review, ignoring strategic-only readiness signals for completion.
- Added tests for strategic/terminal review distinction and strategic reviewer reports not completing goals.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs` passed (31 tests).

---

## TASK-007: State Storage Extensions

Status: DONE

### Objective

Improve durable state beyond minimal iteration/session refs.

### Acceptance Checks

- [x] Decide whether to add `blockerHistory[]`, `doctrine[]`, both, or neither yet.
- [x] If added, normalize old goals safely.
- [x] Add iteration compaction/rollup policy or explicitly defer it.
- [x] Decide how to distinguish pinned important evidence from recent evidence.
- [x] Consider a command/tool to inspect referenced persisted subagent sessions; implement or explicitly defer.
- [x] Relevant tests pass.

### Done Evidence

- Decision: added `blockerHistory[]`, `doctrine[]`, and `pinnedEvidence[]` as first-class normalized goal state fields.
- Old goals are safely normalized with empty arrays for the new fields in `normalizeGoal`.
- Added bounded iteration compaction policy via `MAX_STORED_ITERATIONS = 50`; deeper automatic rollup summaries are explicitly deferred in architecture notes.
- Added `pinnedEvidence[]` and `proposedState.pinnedEvidenceToAdd` to distinguish long-lived important evidence from ordinary recent evidence.
- Added `goal_inspect_session`, constrained to session files referenced by current goal iterations, for on-demand inspection of persisted subagent sessions.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs` passed (31 tests); `git diff --check` passed.

---

## TASK-008: Completion Semantics Hardening

Status: DONE

### Objective

Make completion readiness more robust and less prompt-dependent.

### Acceptance Checks

- [x] Reviewer `criteriaAssessment` is reconciled against every current criterion.
- [x] Terminal readiness requires reviewer evidence.
- [x] Current-state freshness requirement is formalized or explicitly deferred.
- [x] Domain-specific verification hooks are considered and implemented or explicitly deferred.
- [x] Unit tests cover readiness rejection for missing criteria assessment/evidence.
- [x] Relevant tests pass.

### Done Evidence

- Terminal reviewer reports now store structured reviewer evidence and `criteriaAssessment` on review records.
- Terminal reviewer `criteriaAssessment` is reconciled against current criteria: missing, duplicate, or unknown criterion ids are rejected, and ready verdicts require each criterion assessment to be `proven` with evidence.
- `completionReadiness` now requires a ready terminal review with structured reviewer evidence and proven per-criterion assessment evidence; worker `ready_for_review` no longer satisfies completion readiness by itself.
- Parent completion review prompt now instructs reviewers to assess every current criterion exactly once and only return ready when all assessments are proven with concrete evidence.
- Architecture notes formalize current-state freshness as terminal reviewer responsibility and explicitly defer automatic freshness windows plus domain-specific verification hooks until scaffold policies define domain recency/hook requirements.
- Manual `goal_review` now accepts structured evidence and per-criterion assessments and routes through the same reviewer merge/readiness logic; manual readiness still requires explicit `update_goal` completion.
- Added focused core coverage for structured manual not-ready reviews.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs` passed (34 tests).

---

## TASK-009: Generic Subagent Reporting Decision

Status: DONE

### Objective

Decide whether generic `subagent` should remain freeform or support optional report contracts.

### Acceptance Checks

- [x] Decision is recorded in README, architecture notes, or this file.
- [x] If report-contract mode is implemented, tests or smoke evidence exist.
- [x] If deferred/freeform, rationale is recorded.
- [x] No accidental behavior change to generic subagent usage without documentation.
- [x] Relevant tests pass if code changes are made.

### Done Evidence

- Decision: generic `subagent` remains freeform for now; agents may be prompted to return JSON, but the tool does not expose or enforce report-contract mode.
- Rationale recorded in README and architecture notes: `/goal` owns structured report validation/merge/lifecycle policy, while generic `subagent` must preserve existing `/agent`, alias, single, parallel, and chain natural-language behavior.
- Deferred option recorded: add an explicit opt-in `reportContract` parameter later only after non-goal schema, validation-error, parallel/chain output, and alias compatibility requirements are clear.
- No generic `subagent` code behavior changed; documentation now states the current behavior and deferral.
- Validation at task completion: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs && git diff --check` passed (33 tests).

---

## TASK-010: Manual Review Data Parity

Status: DONE

### Objective

Make the model-facing `goal_review` tool use the same structured evidence and terminal-readiness data model as delegated reviewer reports.

### Acceptance Checks

- [x] `goal_review` accepts structured top-level evidence.
- [x] `goal_review` accepts per-criterion assessments with structured evidence.
- [x] Manual reviews use the core reviewer merge/readiness path.
- [x] Manual ready reviews remain explicit review records; completion still requires `update_goal`.
- [x] Manual blocked reviews preserve blocked lifecycle behavior.
- [x] Focused tests cover the shared merge semantics.
- [x] Relevant checks pass.

### Done Evidence

- Added structured `evidence` and `criteriaAssessment` parameters to `goal_review`.
- Routed manual review reports through `validateGoalAgentReport` and `applyGoalReviewerReport`, including secret scanning and criterion reconciliation for ready reviews.
- Relaxed terminal assessment completeness for non-ready reviews while retaining full proven evidence requirements for ready reviews.
- Added README documentation and a focused `applyGoalReviewerReport` test for structured manual not-ready reviews.
- Commit: `d6a7a66` (`Fix structured goal review handoff`), pushed to `origin/main`.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs && git diff --check` passed (34 tests).

---

## TASK-011: Role Failure Checkpoints

Status: DONE

### Objective

Preserve useful role outcomes and failure/session metadata when a delegated continuation fails before its final iteration write.

### Acceptance Checks

- [x] Successful observer/researcher/worker/reviewer role results are checkpointed before later work or finalization.
- [x] Failed roles persist bounded failure metadata and session references when available.
- [x] Invalid reports retain their session reference for audit.
- [x] Retries reload current persisted goal state instead of replaying stale in-memory state.
- [x] Checkpoint history is bounded and exposed in context packets.
- [x] Focused tests and syntax checks pass.

### Done Evidence

- Added bounded `roleCheckpoints[]` durable state with a pure append helper and context-packet exposure.
- Checkpointed observer, researcher, worker, scheduled-review, and parent-review outcomes before continuation finalization.
- Preserved session references for agent exits and malformed reports; failure text is bounded and secret-screened.
- Retries now reload the current goal before running the next attempt, preserving intermediate checkpoints.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs && git diff --check` passed (35 tests).

---

## TASK-012: Terminal Goal Lookup Hygiene

Status: DONE

### Objective

Prevent completed or cleared historical goals from being injected as current working context during unrelated conversations.

### Acceptance Checks

- [x] `get_goal` returns a short `NO_ACTIVE_GOAL` response for complete and cleared goals.
- [x] Terminal responses retain compact historical metadata without returning the full goal state.
- [x] Explicit goal lookup guidance discourages unrelated `get_goal` calls.
- [x] Durable goal files remain available for future history/self-improvement work.
- [x] Focused tests and syntax checks pass.

### Done Evidence

- Added pure `isTerminalGoal` classification and focused tests.
- Updated `get_goal` to suppress full terminal state for complete/cleared goals while preserving compact metadata and on-disk history.
- Tightened tool guidance and README documentation around explicit goal usage.
- Commit: `6645615` (`Hide terminal goals from active lookup`), pushed to `origin/main`.
- Validation: `node --check goal-core.mjs && node --check goal.ts && node --test tests/*.test.mjs && git diff --check` passed (36 tests).

---

## TASK-013: Unit Test Hardening Follow-up

Status: DONE

### Objective

Close the highest-value remaining pure-logic test gaps in `/goal` without expanding runtime behavior.

### Acceptance Checks

- [x] Criteria merge tests cover evidence preservation and bounded/deduplicated state.
- [x] Completion readiness tests cover duplicate, unknown, and contradictory reviewer assessments.
- [x] Report validation tests cover nested evidence and role-specific malformed payloads.
- [x] Waiting and blocked policy tests cover all relevant downgrade/allow branches.
- [x] Focused unit tests pass.

### Done Evidence

- Added bounded-state, criterion-evidence-preservation, completion-assessment, and nested-report-validation tests in `tests/goal-core.test.mjs`.
- Existing waiting/blocked policy coverage was retained and included in the validation run.
- Validation: `nix develop --command node --test tests/*.test.mjs` passed (40 tests); `git diff --check` passed.

---

## TASK-014: Goal Orchestration Integration Harness

Status: TODO

### Objective

Add a mocked integration harness for goal continuation orchestration and durable-state handoffs.

### Acceptance Checks

- [ ] Worker continuation persists merged state, iteration metadata, and session references.
- [ ] Observer/researcher reports are checkpointed and handed to the worker.
- [ ] Worker readiness invokes parent review and cannot complete alone.
- [ ] Scheduled strategic reviews cannot complete goals.
- [ ] Agent/report failures preserve checkpoints and retries reload persisted state.
- [ ] Active versus terminal `get_goal` behavior is covered.
