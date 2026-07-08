# /goal Subagent Context Architecture

## Purpose

Migrate `/goal` from a single accumulating conversation context into a durable-state, fresh-context architecture.

The goal runtime should behave like a shift system:

1. Load compact durable goal state.
2. Select a scaffold and role plan.
3. Spawn one or more fresh-context agents.
4. Receive structured reports.
5. Validate and merge only durable facts/evidence/decisions.
6. End the turn with a concise handoff.

Continuity should live in durable artifacts, not in chat history.

## Problems With Current Shape

- Goal continuation turns accumulate context until prompts become bloated.
- Important facts are mixed with conversational residue.
- Worker, observer, reviewer, and researcher responsibilities blur together.
- Completion judgment is performed by the same context that did the work.
- Interfaces between progress, evidence, criteria, and lifecycle are implicit.

## Design Principles

1. **Fresh worker context per continuation**
   - Each goal iteration should start from a compact state packet, not the full prior transcript.

2. **Durable state is authoritative**
   - Goal JSON, criteria, notes, evidence, reviews, and external state beat conversation memory.

3. **Structured interfaces over prose handoff**
   - Subagents return machine-parseable reports with explicit evidence and proposed state changes.

4. **Lifecycle stays orchestrator-owned**
   - Subagents may recommend `complete`, `blocked`, `pause`, etc., but cannot directly mutate lifecycle state.

5. **Evidence before completion**
   - Completion requires passed criteria with evidence plus a reviewer verdict.

6. **One coherent unit per continuation**
   - A continuation should make bounded progress, update state, and stop.

7. **Use the lightest role set that fits**
   - Simple goals may need only a worker. Complex goals may use observer/researcher/reviewer.

## High-Level Architecture

```text
/goal command/runtime
  ├─ shared AgentRunner
  │   ├─ creates fresh persisted Pi sessions
  │   ├─ records sessionFile refs
  │   └─ returns final text, messages, usage, stop/error metadata
  │
  ├─ GoalStore
  │   ├─ goal.json
  │   ├─ criteria
  │   ├─ notes/facts/assumptions/risks/blockers/evidence
  │   ├─ reviews
  │   └─ iteration log
  │
  ├─ GoalOrchestrator
  │   ├─ loads compact state packet
  │   ├─ selects scaffold
  │   ├─ chooses role(s)
  │   ├─ spawns fresh subagent(s)
  │   ├─ validates reports
  │   ├─ applies state updates
  │   └─ schedules next continuation if appropriate
  │
  └─ Subagents
      ├─ observer
      ├─ researcher
      ├─ worker
      ├─ reviewer
      └─ optional experimenter
```

## Roles

### Goal Orchestrator

Owns lifecycle and durable state.

Responsibilities:

- Load current goal state.
- Enforce iteration caps and pause/block/complete status.
- Build compact context packets for subagents.
- Select scaffold and role workflow.
- Spawn subagents in fresh contexts.
- Validate report schemas.
- Apply allowed state updates.
- Reject lifecycle changes without required evidence.
- Append iteration records.
- Queue follow-up turns.

The orchestrator should not do deep implementation work unless the task is trivial.

### Worker

Makes one bounded unit of progress.

Inputs:

- objective
- current summary
- selected scaffold instructions
- relevant criteria
- relevant facts/risks/blockers
- latest observer report, if any
- explicit requested action

Outputs:

- actions taken
- files changed / commands run
- tests or checks run
- evidence gathered
- proposed criteria updates
- proposed fact/risk/blocker updates
- next recommended action
- completion recommendation, if any

### Observer

Inspects current external state and identifies bottlenecks.

Examples:

- repo state
- test status
- running services
- Bitburner game state
- deployment state
- open issues
- current blockers

The observer should not make major changes.

### Researcher

Answers domain or strategy questions.

Examples:

- read docs/source/specs
- search web if local docs are insufficient
- produce conditional doctrine
- identify APIs, constraints, and failure modes

The researcher should not mutate project state except through its report.

### Reviewer

Judges readiness, evidence quality, and risk.

Responsibilities:

- Check whether criteria evidence actually proves the requirement.
- Detect scope shrinkage.
- Identify unverified claims.
- Recommend continue/complete/block.
- Provide concrete gaps.

Reviewer should be independent from the worker context when possible.

### Experimenter

Optional role for uncertain strategy.

Responsibilities:

- Propose controlled experiments.
- Run bounded comparisons.
- Record metrics.
- Recommend doctrine or threshold changes.

## Context Packet

Every subagent receives a compact packet. Avoid raw transcript unless explicitly needed.

```json
{
  "goal": {
    "id": "...",
    "objective": "...",
    "status": "active",
    "stepCount": 12,
    "maxSteps": 30,
    "scaffold": "default"
  },
  "successCriteria": [
    {
      "id": "C1",
      "text": "...",
      "status": "pending|passed|failed",
      "evidence": "..."
    }
  ],
  "currentSummary": "...",
  "checklist": [
    { "text": "...", "done": false, "evidence": "..." }
  ],
  "facts": ["..."],
  "assumptions": ["..."],
  "risks": ["..."],
  "blockers": ["..."],
  "recentEvidence": ["..."],
  "latestReview": {
    "verdict": "ready_to_complete|not_ready|blocked",
    "findings": ["..."],
    "unresolvedGaps": ["..."]
  },
  "scaffoldInstructions": "...",
  "requestedRole": "worker|observer|researcher|reviewer|experimenter",
  "requestedAction": "...",
  "interfaceContract": "Return only the specified JSON report schema."
}
```

## Report Schemas

Subagents should return JSON or a strictly parseable Markdown fenced JSON block. Freeform prose is allowed only in fields designed for prose.

### WorkerReport

```json
{
  "role": "worker",
  "summary": "One-paragraph summary of progress.",
  "actionsTaken": ["..."],
  "filesChanged": [
    { "path": "...", "summary": "..." }
  ],
  "commandsRun": [
    { "command": "...", "outcome": "passed|failed|not_run", "evidence": "..." }
  ],
  "testsRun": [
    { "command": "...", "status": "passed|failed|not_run", "evidence": "..." }
  ],
  "evidence": ["..."],
  "criteriaUpdates": [
    { "id": "C1", "status": "pending|passed|failed", "evidence": "..." }
  ],
  "proposedFacts": ["..."],
  "proposedAssumptions": ["..."],
  "proposedRisks": ["..."],
  "proposedBlockers": ["..."],
  "nextAction": "...",
  "completionRecommendation": {
    "verdict": "continue|ready_for_review|blocked",
    "reason": "..."
  }
}
```

### ObserverReport

```json
{
  "role": "observer",
  "summary": "...",
  "currentState": ["..."],
  "bottlenecks": ["..."],
  "opportunities": ["..."],
  "risks": ["..."],
  "evidence": ["..."],
  "recommendedActions": ["..."],
  "confidence": "low|medium|high"
}
```

### ResearchReport

```json
{
  "role": "researcher",
  "summary": "...",
  "findings": [
    {
      "rule": "...",
      "appliesWhen": "...",
      "avoidOrModifyWhen": "...",
      "recommendedAction": "...",
      "evidence": "path/url/quote",
      "confidence": "low|medium|high"
    }
  ],
  "openQuestions": ["..."],
  "recommendedDoctrineUpdates": ["..."]
}
```

### ReviewerReport

```json
{
  "role": "reviewer",
  "verdict": "ready_to_complete|not_ready|blocked",
  "findings": ["..."],
  "criteriaAssessment": [
    {
      "id": "C1",
      "status": "proven|not_proven|contradicted|missing_evidence",
      "reason": "...",
      "evidence": "..."
    }
  ],
  "unresolvedGaps": ["..."],
  "scopeConcerns": ["..."],
  "recommendedNextAction": "...",
  "evidenceSummary": "..."
}
```

### ExperimentReport

```json
{
  "role": "experimenter",
  "hypothesis": "...",
  "method": "...",
  "metrics": [
    { "name": "...", "value": "...", "evidence": "..." }
  ],
  "result": "...",
  "recommendation": "...",
  "confidence": "low|medium|high"
}
```

## Merge Rules

The orchestrator merges reports conservatively.

### Allowed automatic merges

- Append evidence items with source/command/path.
- Update summary from worker/observer if concise.
- Add nextAction from report.
- Add proposed facts/risks/blockers if non-duplicative and specific.
- Mark criteria `pending` or `failed` from worker evidence.

### Restricted merges

- Marking criteria `passed` should require concrete evidence.
- Marking goal `complete` requires:
  1. all criteria passed with evidence, and
  2. reviewer verdict `ready_to_complete`, and
  3. no unresolved blockers/gaps.
- Marking goal `blocked` requires explicit blocker evidence and preferably repeated blocker history.
- Replacing objective should require user command, not subagent report.
- Clearing or pausing should remain user/runtime-controlled.

### Never merge blindly

- Broad claims without evidence.
- “Tests passed” without command/output.
- Completion recommendations from the worker alone.
- Scope changes hidden as summary updates.
- Destructive operation rationale without explicit evidence.

## Goal Continuation Workflow

### Default single-worker iteration

```text
1. Orchestrator loads goal state.
2. Orchestrator builds WorkerContextPacket.
3. Fresh worker subagent performs one bounded action.
4. Worker returns WorkerReport.
5. Orchestrator validates and merges report.
6. If worker says ready_for_review, spawn reviewer.
7. Orchestrator records nextAction and stops.
```

### Observer-first iteration

Use when external state is likely stale or important.

```text
1. Spawn observer.
2. Merge observer state/evidence.
3. Spawn worker with observer report included.
4. Merge worker report.
5. Stop or review.
```

### Research-first iteration

Use when strategy/domain knowledge is missing.

```text
1. Spawn researcher with focused question.
2. Merge doctrine findings.
3. Either stop with nextAction or spawn worker if action is obvious and bounded.
```

### Completion review iteration

```text
1. Spawn reviewer with objective, criteria, evidence, and current state.
2. Reviewer assesses every criterion.
3. If ready_to_complete, orchestrator may call update_goal complete.
4. Otherwise merge gaps and set nextAction.
```

## Prompting Requirements

Each subagent prompt should include:

- role identity,
- allowed scope,
- explicit non-goals,
- context packet,
- output schema,
- instruction to avoid lifecycle mutation,
- instruction to cite evidence,
- instruction to stop after one coherent unit.

Example worker prompt skeleton:

```text
You are the worker for a durable /goal workflow.
You have fresh context. Do not assume prior chat history.
Use the context packet as the only durable goal state.
Make one bounded unit of progress toward requestedAction.
Run relevant verification if you change code or state.
Do not mark the goal complete or blocked; only recommend.
Return WorkerReport JSON matching the schema.
```

## Handling Context Blowup

The parent conversation should not include full subagent transcripts by default.

Store instead:

- compact report,
- evidence references,
- persisted Pi session file references for debugging/audit.

If a future turn needs details, retrieve the raw session transcript on demand.

## State Storage Additions

Consider extending goal state with:

```json
{
  "iterations": [
    {
      "step": 12,
      "timestamp": "...",
      "roles": ["observer", "worker"],
      "summary": "...",
      "evidence": ["..."],
      "nextAction": "...",
      "sessionRefs": [
        { "role": "worker", "sessionFile": "...", "timestamp": "..." }
      ]
    }
  ],
  "doctrine": [
    {
      "rule": "...",
      "appliesWhen": "...",
      "evidence": "...",
      "confidence": "..."
    }
  ],
  "blockerHistory": [
    {
      "blocker": "...",
      "firstSeenStep": 10,
      "lastSeenStep": 12,
      "consecutiveCount": 3,
      "evidence": ["..."]
    }
  ]
}
```

Keep this bounded. Roll old iterations into summaries.

## Completion Semantics

Completion is a claim about the objective, not the latest worker report.

Before `update_goal({status:"complete"})`:

1. Criteria exist for non-trivial goals.
2. Every criterion is `passed` with evidence.
3. Latest reviewer verdict is `ready_to_complete`.
4. Reviewer found no unresolved gaps.
5. Current state has been inspected recently enough for the domain.
6. Tests/checks appropriate to the domain have passed or are explicitly not applicable.

## Blocked Semantics

A blocker means no meaningful progress is possible without user input or external change.

Do not mark blocked merely because:

- work is hard,
- strategy is uncertain,
- tests are failing,
- more research is needed,
- progress is slow.

Prefer storing blocker history and requiring repeated evidence before lifecycle `blocked`.

## Implementation Plan

### Phase 1: Report contracts

- Add TypeScript types for report schemas.
- Add validators for required fields and enum values.
- Add tests for accepting/rejecting reports.

### Phase 2: Fresh-context execution

- Add an internal orchestrator helper to invoke a subagent with a context packet.
- Capture raw transcript refs separately from merged state.
- Keep parent visible response concise.

### Phase 3: Merge engine

- Implement conservative merge rules.
- Add tests for criteria/evidence/review readiness.
- Prevent worker-only completion.

### Phase 4: Role workflows

- Implement default worker workflow.
- Add reviewer-on-ready workflow.
- Add optional observer-first and research-first workflows.

### Phase 5: Scaffold integration

- Allow scaffolds to specify preferred role workflow:
  - `worker-only`
  - `observer-worker`
  - `research-worker`
  - `worker-reviewer`
  - `operations`
- Keep scaffold body as operating method, not lifecycle authority.

### Phase 6: Context compaction

- Store iteration reports.
- Roll older iterations into summaries.
- Limit evidence lists by recency plus pinned important evidence.

## Open Questions

- Should reviewer always be a separate model/session, or only for completion?
- Should observer run every N iterations automatically?
- Should raw subagent transcripts be stored in goal state or external session logs?
- Should criteria be mandatory for all goals over a complexity threshold?
- How should custom scaffolds declare desired role workflow?
- Should blocker history require exact string matching or semantic grouping?

## Minimal Viable Migration

A useful first version needs only:

1. Fresh worker subagent per continuation.
2. WorkerReport schema.
3. Conservative merge into existing `goal_note` fields.
4. ReviewerReport before completion.
5. Parent context contains only compact reports, not full worker transcript.

This should solve the immediate context blowup while preserving the current `/goal` lifecycle model.
