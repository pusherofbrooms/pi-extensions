# Goal Mission Control: Low-Friction Zenith Ideas for `/goal`

## Purpose

Improve Pi's `/goal` extension for long-horizon work by adopting the highest-value Zenith-style control-loop disciplines without turning `/goal` into a full multi-agent harness.

The target failure mode is **premature or weakly justified completion**: the agent makes progress, loses the original definition of done, accepts thin evidence, or stops because the latest summary sounds good.

This plan intentionally avoids full Zenith features such as task graphs, automatic worker/validator dispatch, gates, and project-local runtime trees for the first pass.

## Design Principles

- Keep `/goal <objective>` simple and useful for small tasks.
- Add structure only around definition of done, evidence, blockers, and review.
- Make completion harder to fake than progress.
- Keep lifecycle ownership in the extension.
- Prefer small, testable additions to a new orchestration system.
- Do not add Bitburner-specific behavior.

## Current Baseline

`goal.ts` currently provides:

- `/goal` command for create/status/pause/resume/clear/complete/max/more.
- Durable state under `~/.pi/agent/goals/`.
- Per-project current-goal index.
- Autonomous follow-up turns via `pi.sendUserMessage(...)`.
- Tools:
  - `get_goal`
  - `goal_note`
  - `update_goal`
- Iteration caps and step counting.
- Secret detection for stored objectives and notes.

## Narrow Target Shape

Move from:

```text
objective -> autonomous turns -> notes -> complete
```

to:

```text
objective -> success criteria -> gap-finding turns -> evidence -> terminal review -> complete
```

## Feature 1: Success Criteria

Add explicit, evidence-bearing success criteria to goal state.

### State

```ts
type GoalCriterionStatus = "pending" | "passed" | "failed";

type GoalCriterion = {
  id: string;
  text: string;
  status: GoalCriterionStatus;
  evidence?: string;
};
```

Add to `StoredGoal`:

```ts
criteria: GoalCriterion[];
```

Migration behavior:

- Existing goal files without `criteria` normalize to `[]`.
- No migration command is required for old goals.

### Tool: `goal_criteria`

Purpose: create or replace the current goal's success criteria.

Parameters:

```ts
{
  criteria: Array<{
    id?: string;
    text: string;
    status?: "pending" | "passed" | "failed";
    evidence?: string;
  }>;
}
```

Behavior:

- Auto-generate IDs such as `CRIT-001` when omitted.
- Reject duplicate IDs.
- Reject empty criterion text.
- Apply existing secret detection to text and evidence.
- Default status to `pending`.

Prompt guidance:

- For complex or long-horizon goals, establish success criteria before doing substantial work.
- Do not call `update_goal` until every criterion is passed with concrete evidence.

### Tool: `goal_criterion_update`

Purpose: update the status/evidence for one or more existing criteria.

Parameters:

```ts
{
  updates: Array<{
    id: string;
    status: "pending" | "passed" | "failed";
    evidence?: string;
  }>;
}
```

Behavior:

- Reject unknown criterion IDs.
- Require evidence when marking a criterion `passed`.
- Apply secret detection to evidence.
- Append a note summarizing changed criterion statuses.

## Feature 2: Terminal Review

Add an explicit terminal review step before completion.

### State

```ts
type GoalReviewVerdict = "ready_to_complete" | "not_ready" | "blocked";

type GoalReview = {
  timestamp: string;
  verdict: GoalReviewVerdict;
  findings: string[];
  unresolvedGaps?: string[];
  evidenceSummary: string;
};
```

Add to `StoredGoal`:

```ts
reviews: GoalReview[];
```

Keep only the latest N reviews, e.g. 20.

### Tool: `goal_review`

Purpose: record a terminal-readiness or strategic review.

Parameters:

```ts
{
  verdict: "ready_to_complete" | "not_ready" | "blocked";
  findings: string[];
  unresolvedGaps?: string[];
  evidenceSummary: string;
}
```

Behavior:

- Reject empty findings.
- Require `unresolvedGaps` when verdict is `not_ready` or `blocked`.
- Apply secret detection to all text fields.
- If verdict is `blocked`, move the goal to `blocked`.
- If verdict is `not_ready`, keep the goal active and update `nextAction` toward the most important gap.

### Completion readiness check

Modify `update_goal({ status: "complete" })` to check readiness.

Recommended first-pass policy:

- If criteria exist, all must be `passed` and have evidence.
- Latest review must have verdict `ready_to_complete`.
- Latest review must not list unresolved gaps.
- Goal must not be `blocked`.

If not ready, the tool should refuse completion and return a concise list of missing items.

This is the single most important Zenith-inspired safeguard: completion becomes an evidence-backed decision rather than a summary-writing exercise.

## Feature 3: Blocked Status

Add a model-controlled way to stop cleanly when the goal cannot safely or productively continue.

### State

Extend status:

```ts
type GoalStatus = "active" | "paused" | "blocked" | "complete" | "cleared";
```

`paused` remains user-controlled. `blocked` means the model/runtime has identified a concrete blocker.

### Tool: `goal_block`

Parameters:

```ts
{
  reason: string;
  neededFromUser?: string;
  evidence?: string;
}
```

Behavior:

- Set status to `blocked`.
- Set `stopReason` to `blocked` or a short blocker code.
- Set `nextAction` to the user/runtime action needed to unblock.
- Append a note with blocker evidence.
- Do not queue further continuations while blocked.

### Command behavior

Existing `/goal resume` can resume blocked goals by setting status back to `active` and clearing `stopReason`.

`/goal status` should clearly show blocked reason and needed action.

## Feature 4: Structured Goal Notes

Keep the current flexible `goal_note`, but add optional structured fields that help long-horizon continuity.

### Tool changes

Extend `goal_note` parameters:

```ts
{
  summary?: string;
  checklist?: GoalChecklistItem[];
  nextAction?: string;
  note?: string;
  facts?: string[];
  assumptions?: string[];
  risks?: string[];
  blockers?: string[];
  evidence?: string[];
}
```

Add to `StoredGoal`:

```ts
facts: string[];
assumptions: string[];
risks: string[];
blockers: string[];
evidence: string[];
```

Behavior:

- Treat provided arrays as replacements, not appends, to keep memory curated.
- Apply secret detection to all strings.
- Render these sections in `get_goal` after summary/next action and before recent notes.

This gives the model durable categories for the most common long-horizon confusions:

- What is known?
- What is guessed?
- What might go wrong?
- What is preventing progress?
- What evidence already exists?

## Feature 5: Stronger Gap-Finding Continuation Prompt

Update `continuationPrompt(goal)` to make every iteration explicitly reopen the gap between current state and original objective.

Add guidance along these lines:

```text
Before acting, compare the current goal state against the original objective and success criteria.
Identify the most important remaining gap.
Choose exactly one gap to close or investigate this turn.
After acting, record concrete evidence and update criteria/review/blocker state as appropriate.
Do not mark complete just because progress was made; completion requires passed criteria and a ready terminal review.
```

If criteria are absent and the objective appears broad or long-horizon, prompt the model to create criteria first:

```text
If this is a complex or long-horizon goal and no success criteria exist, use goal_criteria before substantial execution.
```

This is cheap and imports much of Zenith's RALPH-like repeated gap-finding discipline.

## Feature 6: Periodic Strategic Review

Add optional periodic review without implementing a task graph.

### State

```ts
reviewEvery?: number;
lastReviewStep?: number;
```

### Commands

Add:

```text
/goal review-every <positive-number|none>
```

Behavior:

- `none` disables periodic reviews.
- A number enables review mode every N counted goal iterations.

### Runtime prompt behavior

When an active goal reaches a review interval, the continuation prompt should ask for a strategic review instead of normal execution.

Review questions:

- Are we still aligned with the original objective?
- Are success criteria missing, stale, too broad, or already satisfied?
- Are notes/facts/assumptions/risks/blockers stale?
- Are we repeating ineffective actions?
- What is the highest-value next gap?
- Should the goal continue, replan via criteria/notes, block, or complete after terminal review?

The iteration should end with `goal_review`, `goal_note`, `goal_block`, or updated criteria, not with broad new execution.

## Rendering in `get_goal`

`get_goal` should render, in order:

1. Status summary.
2. Objective.
3. Step count and max iteration cap.
4. Success criteria with statuses and evidence.
5. Summary and next action.
6. Facts, assumptions, risks, blockers, evidence.
7. Checklist, for backwards compatibility.
8. Latest review verdict.
9. Recent notes.

This makes the model see definition-of-done and evidence before conversational notes.

## README Updates

Document the new lightweight long-horizon workflow:

1. Start a goal.
2. Define success criteria for complex goals.
3. Work one gap per iteration.
4. Record evidence.
5. Use `goal_review` before completion.
6. Use `goal_block` when missing information or unsafe conditions prevent progress.

Keep the existing simple workflow visible so `/goal <objective>` does not look heavyweight.

## Testing Plan

Extract pure helpers from `goal.ts` if needed, e.g. into `goal-core.mjs` or a TypeScript module with a simple test path.

Unit tests should cover:

- Goal normalization defaults for old goal files.
- Criterion ID generation.
- Criterion validation and duplicate rejection.
- Criterion update behavior, especially requiring evidence for `passed`.
- Review validation.
- Completion readiness checks.
- Blocked status behavior.
- Secret detection across new fields.

Suggested test file:

```text
tests/goal-core.test.mjs
```

## Rollout Order

Recommended order:

1. Add normalization helpers and tests.
2. Add `criteria` state and `goal_criteria`.
3. Add `goal_criterion_update`.
4. Add `reviews` state and `goal_review`.
5. Add completion readiness enforcement in `update_goal`.
6. Add `blocked` status and `goal_block`.
7. Add structured note fields.
8. Strengthen continuation prompt.
9. Add optional periodic review command and prompt mode.
10. Update README.

## Deferred / Non-Goals

Do not implement these in the first pass:

- Full task graph.
- Work/validate/gate runtime.
- Direct subagent dispatch from `goal.ts`.
- Resource locking or conflict scheduling.
- Project-local mission artifact trees.
- Domain-specific Bitburner logic.
- Full Zenith compatibility.

These may be valuable later, but they are not required to capture the core benefit: explicit criteria, evidence-backed completion, blockers, review, and repeated gap finding.

## Open Questions

- Should `goal_review` be required for all completions, or only when criteria exist?
- Should `/goal <objective>` auto-create one broad pending criterion from the objective?
- Should periodic review default to a value such as every 5 iterations for goals created with `--max`, or remain opt-in?
- Should `blocked` be settable only through `goal_block`, or should `goal_review({ verdict: "blocked" })` also set it?
- Should structured `facts`/`assumptions`/`risks` arrays be replacements or append-only with compaction? First pass recommends replacements.
