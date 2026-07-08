import test from "node:test";
import assert from "node:assert/strict";
import {
  appendUniqueStrings,
  applyCriterionUpdates,
  applyGoalAgentReport,
  applyGoalReviewerReport,
  blockedStatusFromReport,
  buildGoalContextPacket,
  completionReadiness,
  mergeCriteria,
  normalizeCriteriaInputs,
  normalizeGoal,
  recommendScaffoldId,
  selectGoalWorkflowPlan,
  validateGoalAgentReport,
  validateReview,
  waitingStatusFromReport,
} from "../goal-core.mjs";

const evidence = (kind = "test", ref = "node --test") => ({ kind, ref, status: "passed", summary: "Proof." });

function baseGoal(overrides = {}) {
  return {
    id: "g1",
    status: "active",
    stepCount: 1,
    summary: "start",
    checklist: [],
    criteria: [{ id: "CRIT-001", text: "Done", status: "pending" }],
    reviews: [],
    facts: [],
    assumptions: [],
    risks: [],
    blockers: [],
    evidence: [],
    notes: [],
    nextAction: "continue",
    ...overrides,
  };
}

function workerReport(overrides = {}) {
  return {
    schemaVersion: 1,
    role: "worker",
    outcome: "progress",
    summary: "Made progress.",
    confidence: "medium",
    actions: [{ summary: "Worked." }],
    evidence: [evidence("file", "goal-core.mjs")],
    nextAction: "Continue.",
    ...overrides,
  };
}

test("normalizeGoal adds new goal fields for old stored goals", () => {
  const goal = normalizeGoal({ id: "g1", status: "active" });
  assert.equal(goal.scaffold, "default");
  assert.deepEqual(goal.criteria, []);
  assert.deepEqual(goal.reviews, []);
  assert.deepEqual(goal.facts, []);
  assert.deepEqual(goal.assumptions, []);
  assert.deepEqual(goal.risks, []);
  assert.deepEqual(goal.blockers, []);
  assert.deepEqual(goal.evidence, []);
  assert.deepEqual(goal.iterations, []);
});

test("normalizeCriteriaInputs allocates ids and requires passed evidence", () => {
  assert.deepEqual(normalizeCriteriaInputs([{ text: "Done means verified" }]), [
    { id: "CRIT-001", text: "Done means verified", status: "pending", evidence: undefined },
  ]);
  assert.throws(
    () => normalizeCriteriaInputs([{ text: "Done", status: "passed" }]),
    /requires evidence/,
  );
});

test("applyCriterionUpdates rejects unknown ids and requires evidence for passed", () => {
  const criteria = [{ id: "CRIT-001", text: "Done", status: "pending" }];
  assert.throws(() => applyCriterionUpdates(criteria, [{ id: "NOPE", status: "failed" }]), /Unknown/);
  assert.throws(() => applyCriterionUpdates(criteria, [{ id: "CRIT-001", status: "passed" }]), /requires evidence/);
  assert.equal(applyCriterionUpdates(criteria, [{ id: "CRIT-001", status: "passed", evidence: "test output" }])[0].status, "passed");
});

test("appendUniqueStrings appends and deduplicates durable state", () => {
  assert.deepEqual(appendUniqueStrings(["A", "b"], [" a ", "C", ""]), ["A", "b", "C"]);
});

test("mergeCriteria preserves existing criteria while adding proposed criteria and updates", () => {
  const existing = [{ id: "CRIT-001", text: "Existing", status: "pending" }];
  const merged = mergeCriteria(existing, [{ text: "New" }], [{ id: "CRIT-001", status: "failed", evidence: "observed failing" }]);
  assert.deepEqual(merged, [
    { id: "CRIT-001", text: "Existing", status: "failed", evidence: "observed failing" },
    { id: "CRIT-002", text: "New", status: "pending", evidence: undefined },
  ]);
});

test("mergeCriteria does not downgrade existing criteria when re-proposed without status", () => {
  const existing = [{ id: "CRIT-001", text: "Existing", status: "passed", evidence: "proof" }];
  assert.deepEqual(mergeCriteria(existing, [{ id: "CRIT-001", text: "Existing renamed" }]), [
    { id: "CRIT-001", text: "Existing renamed", status: "passed", evidence: "proof" },
  ]);
});

test("blockedStatusFromReport downgrades unevidenced strict blocker", () => {
  assert.equal(blockedStatusFromReport({ outcome: "blocked", summary: "stuck" }, { blockedPolicy: "external-blocker-only" }).blocked, false);
  assert.equal(blockedStatusFromReport({ outcome: "blocked", blockers: ["Need user login"], evidence: ["Login prompt observed"] }, { blockedPolicy: "external-blocker-only" }).blocked, true);
});

test("waitingStatusFromReport follows scaffold policy", () => {
  assert.equal(waitingStatusFromReport({ outcome: "waiting" }, { waitingAllowed: true }).waiting, true);
  assert.equal(waitingStatusFromReport({ outcome: "waiting" }, { waitingAllowed: false }).waiting, false);
  assert.equal(waitingStatusFromReport({ outcome: "progress" }, { waitingAllowed: true }).waiting, false);
});

test("buildGoalContextPacket produces auditable structured subagent input", () => {
  const goal = {
    id: "g1",
    objective: "Implement goal infra",
    status: "active",
    cwd: "/repo",
    stepCount: 2,
    maxIterations: 5,
    scaffold: "default",
    summary: "Some progress",
    checklist: [{ text: "done", done: false }],
    criteria: [{ id: "CRIT-001", text: "verified", status: "pending" }],
    facts: ["fact"],
    assumptions: ["assumption"],
    risks: ["risk"],
    blockers: ["blocker"],
    evidence: ["evidence"],
    reviews: [{ timestamp: "t", verdict: "not_ready", findings: ["gap"], unresolvedGaps: ["gap"], evidenceSummary: "checked" }],
    notes: [{ timestamp: "n", text: "note" }],
    iterations: [{ step: 1 }],
    nextAction: "continue",
  };
  const scaffold = { id: "default", name: "Default", description: "Generic", body: "Do work", source: "bundled", policy: { workflow: "worker" } };
  const packet = buildGoalContextPacket(goal, scaffold, { role: "reviewer", action: "verify" });

  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.goal.objective, "Implement goal infra");
  assert.deepEqual(packet.criteria, goal.criteria);
  assert.deepEqual(packet.state.checklist, goal.checklist);
  assert.deepEqual(packet.state.facts, ["fact"]);
  assert.deepEqual(packet.state.assumptions, ["assumption"]);
  assert.deepEqual(packet.state.risks, ["risk"]);
  assert.deepEqual(packet.state.blockers, ["blocker"]);
  assert.deepEqual(packet.state.evidence, ["evidence"]);
  assert.equal(packet.state.latestReview.verdict, "not_ready");
  assert.equal(packet.scaffold.id, "default");
  assert.equal(packet.scaffold.body, "Do work");
  assert.equal(packet.scaffold.policy.workflow, "worker");
  assert.equal(packet.request.role, "reviewer");
  assert.equal(packet.request.action, "verify");
  assert.equal(packet.reportContractHint.lifecycleAuthority, "orchestrator");
});

test("buildGoalContextPacket carries prior observer reports for worker handoff", () => {
  const observerReport = {
    schemaVersion: 1,
    role: "observer",
    outcome: "progress",
    summary: "Repo has uncommitted tracked changes.",
    confidence: "medium",
    actions: [{ summary: "Checked git status." }],
    evidence: [{ kind: "command", ref: "git status --short", status: "passed", summary: "Tracked changes observed." }],
    nextAction: "Worker should inspect the tracked changes before editing.",
  };
  const packet = buildGoalContextPacket(baseGoal(), { id: "default", policy: { workflow: "observer-worker" } }, {
    role: "worker",
    action: "continue_after_observation",
    workflow: "observer-worker",
    workflowRoles: ["observer", "worker"],
    priorRoleReports: [observerReport],
  });

  assert.equal(packet.request.role, "worker");
  assert.equal(packet.request.priorRoleReports[0].role, "observer");
  assert.match(packet.request.priorRoleReports[0].summary, /uncommitted tracked changes/);
});

test("selectGoalWorkflowPlan supports scaffold workflow metadata safely", () => {
  assert.deepEqual(selectGoalWorkflowPlan({ policy: { workflow: "worker" } }).roles, ["worker"]);
  assert.deepEqual(selectGoalWorkflowPlan({ policy: { workflow: "worker-reviewer" } }).roles, ["worker", "reviewer"]);
  assert.deepEqual(selectGoalWorkflowPlan({ policy: { workflow: "observer-worker" } }).roles, ["observer", "worker"]);
  assert.deepEqual(selectGoalWorkflowPlan({ policy: { workflow: "research-worker" } }).roles, ["researcher", "worker"]);
  const operations = selectGoalWorkflowPlan({ policy: { workflow: "operations" } });
  assert.equal(operations.workerAction, "operations_cycle");
  assert.equal(operations.operatingCycle, true);
  assert.equal(operations.lifecycleAuthority, "orchestrator");
  const fallback = selectGoalWorkflowPlan({ policy: { workflow: "surprise" } });
  assert.equal(fallback.workflow, "worker");
  assert.match(fallback.fallbackReason, /Unknown scaffold workflow/);
});

test("recommendScaffoldId classifies common goal shapes", () => {
  assert.equal(recommendScaffoldId("write a sad elf story to /tmp/elves.md"), "default");
  assert.equal(recommendScaffoldId("implement and test a simon says clone"), "zenith");
  assert.equal(recommendScaffoldId("start a bitburner session and monitor automation"), "operations");
});

test("validateReview requires findings, evidence, and gaps for non-ready verdicts", () => {
  assert.throws(() => validateReview({ verdict: "ready_to_complete", findings: [], evidenceSummary: "x" }), /findings/);
  assert.throws(() => validateReview({ verdict: "blocked", findings: ["x"], evidenceSummary: "x" }), /unresolvedGaps/);
  assert.doesNotThrow(() => validateReview({ verdict: "not_ready", findings: ["x"], unresolvedGaps: ["gap"], evidenceSummary: "x" }));
});

test("completionReadiness requires criteria evidence and ready terminal review", () => {
  const base = { status: "active", criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] };
  assert.equal(completionReadiness(base).ready, false);
  assert.equal(completionReadiness({ ...base, reviews: [{ verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "proof" }] }).ready, true);
  assert.equal(completionReadiness({ ...base, status: "blocked", reviews: [{ verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "proof" }] }).ready, false);
});

test("applyGoalAgentReport merges proposed durable state and evidence", () => {
  const merged = applyGoalAgentReport(baseGoal(), workerReport({
    proposedState: {
      factsToAdd: ["Fact A"],
      assumptionsToAdd: ["Assumption A"],
      risksToAdd: ["Risk A"],
      blockersToAdd: ["Potential blocker A"],
      evidenceToAdd: [evidence("command", "npm test")],
      checklist: [{ text: "Merge tested", done: true, evidence: "unit test" }],
    },
  }), {}, { now: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(merged.facts, ["Fact A"]);
  assert.deepEqual(merged.assumptions, ["Assumption A"]);
  assert.deepEqual(merged.risks, ["Risk A"]);
  assert.deepEqual(merged.blockers, ["Potential blocker A"]);
  assert.equal(merged.checklist[0].done, true);
  assert.equal(merged.evidence.length, 2);
  assert.equal(merged.notes.at(-1).timestamp, "2026-01-01T00:00:00.000Z");
});

test("applyGoalAgentReport covers criteria add, update, and pass evidence", () => {
  const merged = applyGoalAgentReport(baseGoal(), workerReport({
    criteriaUpdates: [
      { operation: "add", text: "New criterion", status: "pending" },
      { operation: "update_status", id: "CRIT-001", status: "passed", evidence: [evidence("test", "node --test tests/goal-core.test.mjs")] },
    ],
  }));

  assert.equal(merged.criteria[0].status, "passed");
  assert.match(merged.criteria[0].evidence, /node --test/);
  assert.equal(merged.criteria[1].id, "CRIT-002");
  assert.equal(merged.criteria[1].status, "pending");
});

test("worker ready_for_review records readiness but does not complete goal by itself", () => {
  const merged = applyGoalAgentReport(baseGoal({
    criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }],
  }), workerReport({ outcome: "ready_for_review", nextAction: undefined }));

  assert.equal(merged.status, "active");
  assert.equal(merged.reviews.at(-1).verdict, "ready_to_complete");
  assert.equal(merged.nextAction, "Parent should verify readiness and complete the goal if evidence is sufficient.");
  assert.equal(completionReadiness(merged).ready, true);
});

test("applyGoalReviewerReport completes only when reviewer verdict and readiness agree", () => {
  const readyGoal = baseGoal({ criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] });
  const ready = applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Ready.",
    confidence: "high",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Evidence sufficient."],
    criteriaAssessment: [],
  });
  assert.equal(ready.status, "complete");

  const missingCriterion = applyGoalReviewerReport(baseGoal(), {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Looks ready but criterion is pending.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Review says ready."],
    criteriaAssessment: [],
  });
  assert.equal(missingCriterion.status, "active");

  const notReady = applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Gap found.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "not_ready",
    findings: ["Missing docs."],
    unresolvedGaps: ["Update docs."],
    criteriaAssessment: [],
  });
  assert.equal(notReady.status, "active");
  assert.equal(notReady.nextAction, "Update docs.");
});

test("applyGoalAgentReport follows waiting and blocked policies", () => {
  const waitingDowngraded = applyGoalAgentReport(baseGoal(), workerReport({
    outcome: "waiting",
    wait: { condition: "CI running", resumeTrigger: "CI finishes" },
    nextAction: undefined,
  }), { policy: { waitingAllowed: false } });
  assert.equal(waitingDowngraded.status, "active");
  assert.match(waitingDowngraded.notes.at(-1).text, /treated as progress/);
  assert.equal(waitingDowngraded.nextAction, "CI finishes");

  const waitingAllowed = applyGoalAgentReport(baseGoal(), workerReport({
    outcome: "waiting",
    wait: { condition: "CI running", resumeTrigger: "CI finishes" },
    nextAction: undefined,
  }), { policy: { waitingAllowed: true } });
  assert.equal(waitingAllowed.nextAction, "CI finishes");
  assert.doesNotMatch(waitingAllowed.notes.at(-1).text, /treated as progress/);

  const blocked = applyGoalAgentReport(baseGoal(), workerReport({
    outcome: "blocked",
    blocker: { reason: "Need user token", needed: "User provides token", evidence: [evidence("observation", "prompt")] },
    nextAction: undefined,
  }), { policy: { blockedPolicy: "external-blocker-only" } });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.stopReason, "blocked");
  assert.deepEqual(blocked.blockers, ["Need user token"]);

  const blockedDowngraded = applyGoalAgentReport(baseGoal(), workerReport({
    outcome: "blocked",
    blocker: { reason: "Prefer to stop", needed: "None", evidence: [evidence("observation", "local")] },
    nextAction: undefined,
  }), { policy: { blockedPolicy: "never" } });
  assert.equal(blockedDowngraded.status, "active");
  assert.match(blockedDowngraded.notes.at(-1).text, /treated as progress/);
});

test("validateGoalAgentReport accepts structured observer reports", () => {
  assert.doesNotThrow(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "observer",
    outcome: "progress",
    summary: "Current repo state inspected; tests are stale.",
    confidence: "medium",
    actions: [{
      summary: "Inspected git status and test metadata.",
      evidence: [{ kind: "command", ref: "git status --short", status: "passed", summary: "Repo state observed." }],
    }],
    evidence: [{ kind: "observation", ref: "repo", status: "observed", summary: "Worker should account for local state." }],
    proposedState: {
      factsToAdd: ["Repo state was inspected before worker execution."],
      risksToAdd: ["Local state may be stale if worker delays after observation."],
      blockersToAdd: ["No terminal blocker; worker should verify before mutating."],
    },
    nextAction: "Worker should proceed with current-state evidence in mind.",
  }));
});

test("validateGoalAgentReport rejects observer completion claims and evidence-free progress", () => {
  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "observer",
    outcome: "ready_for_review",
    summary: "Looks complete.",
    confidence: "medium",
    actions: [],
    evidence: [{ kind: "observation", ref: "goal", summary: "Observed." }],
  }), /Observer report outcome/);

  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "observer",
    outcome: "progress",
    summary: "Inspected something.",
    confidence: "medium",
    actions: [{ summary: "Inspected." }],
    evidence: [],
    nextAction: "Continue.",
  }), /inspection evidence/);
});

test("validateGoalAgentReport accepts structured worker reports", () => {
  assert.doesNotThrow(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "worker",
    outcome: "progress",
    summary: "Implemented a shared report schema.",
    confidence: "medium",
    actions: [{ summary: "Updated schema validators." }],
    evidence: [{ kind: "file", ref: "goal-core.mjs", status: "modified", summary: "Added report validation." }],
    proposedState: {
      factsToAdd: ["Reports use schemaVersion 1."],
      evidenceToAdd: [{ kind: "test", ref: "node --test tests/*.test.mjs", status: "passed", summary: "Tests passed." }],
    },
    criteriaUpdates: [{ operation: "add", text: "Reports validate successfully.", status: "pending" }],
    nextAction: "Adapt goal worker prompt.",
  }));
});

test("validateGoalAgentReport rejects weak completion and blocker claims", () => {
  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "worker",
    outcome: "progress",
    summary: "Done",
    confidence: "high",
    actions: [],
    evidence: [],
    criteriaUpdates: [{ operation: "update_status", id: "CRIT-001", status: "passed" }],
    nextAction: "Complete.",
  }), /passed status requires evidence/);

  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "worker",
    outcome: "blocked",
    summary: "Blocked",
    confidence: "medium",
    actions: [],
    evidence: [],
  }), /blocker.reason/);
});

test("validateGoalAgentReport enforces reviewer readiness shape", () => {
  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Ready despite gaps",
    confidence: "medium",
    actions: [],
    evidence: [{ kind: "observation", ref: "goal state", summary: "Reviewed." }],
    verdict: "ready_to_complete",
    findings: ["Looks ready."],
    unresolvedGaps: ["Still missing tests."],
    criteriaAssessment: [],
  }), /must not include unresolvedGaps/);
});
