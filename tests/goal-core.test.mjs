import test from "node:test";
import assert from "node:assert/strict";
import {
  appendGoalRoleCheckpoint,
  appendUniqueStrings,
  applyCriterionUpdates,
  applyGoalAgentReport,
  applyGoalReviewerReport,
  blockedStatusFromReport,
  buildGoalContextPacket,
  completionReadiness,
  currentGoalPhase,
  isTerminalGoal,
  latestTerminalReview,
  mergeCriteria,
  nextGoalPhase,
  normalizeCriteriaInputs,
  normalizePhases,
  normalizeGoal,
  recommendScaffoldId,
  resolveGoalContextProfile,
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

const provenAssessment = (id = "CRIT-001") => ({ id, status: "proven", reason: "Criterion evidence was verified.", evidence: [evidence("observation", `criterion ${id}`)] });

test("terminal goal lookup states are distinguished from resumable goals", () => {
  assert.equal(isTerminalGoal({ status: "complete" }), true);
  assert.equal(isTerminalGoal({ status: "cleared" }), true);
  assert.equal(isTerminalGoal({ status: "active" }), false);
  assert.equal(isTerminalGoal({ status: "blocked" }), false);
  assert.equal(isTerminalGoal({ status: "paused" }), false);
});

test("phase normalization selects the active phase and next phase", () => {
  const goal = normalizeGoal({
    status: "active",
    phases: [
      { id: "plan", title: "Plan", status: "pending" },
      { id: "run", title: "Run", status: "active" },
    ],
  });
  assert.equal(goal.currentPhaseId, "run");
  assert.equal(currentGoalPhase(goal).id, "run");
  assert.equal(nextGoalPhase(goal), null);
  assert.equal(normalizePhases([{ title: "First" }])[0].id, "PHASE-001");
});

test("normalizeGoal adds new goal fields for old stored goals", () => {
  const goal = normalizeGoal({ id: "g1", status: "active" });
  assert.equal(goal.scaffold, "default");
  assert.deepEqual(goal.criteria, []);
  assert.deepEqual(goal.reviews, []);
  assert.deepEqual(goal.facts, []);
  assert.deepEqual(goal.assumptions, []);
  assert.deepEqual(goal.risks, []);
  assert.deepEqual(goal.blockers, []);
  assert.deepEqual(goal.blockerHistory, []);
  assert.deepEqual(goal.doctrine, []);
  assert.deepEqual(goal.evidence, []);
  assert.deepEqual(goal.pinnedEvidence, []);
  assert.deepEqual(goal.roleCheckpoints, []);
  assert.deepEqual(goal.iterations, []);
});

test("appendGoalRoleCheckpoint keeps bounded role failure history", () => {
  const goal = { id: "g1", roleCheckpoints: [{ role: "observer", status: "completed" }] };
  const checkpointed = appendGoalRoleCheckpoint(goal, { role: "worker", status: "failed" }, 1);
  assert.deepEqual(checkpointed.roleCheckpoints, [{ role: "worker", status: "failed" }]);
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

test("appendUniqueStrings keeps the newest bounded state entries", () => {
  assert.deepEqual(appendUniqueStrings(["A", "B"], ["C", "D"], 3), ["B", "C", "D"]);
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

test("criterion updates preserve prior evidence when only status changes", () => {
  const criteria = [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "original proof" }];
  assert.deepEqual(applyCriterionUpdates(criteria, [{ id: "CRIT-001", status: "failed" }]), [
    { id: "CRIT-001", text: "Done", status: "failed", evidence: "original proof" },
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

test("buildGoalContextPacket projects compact role-specific context", () => {
  const goal = {
    id: "g1",
    objective: "Implement goal infra",
    status: "active",
    cwd: "/repo",
    stepCount: 2,
    maxIterations: 5,
    summary: "Some progress",
    checklist: [{ text: "done", done: false }],
    criteria: [{ id: "CRIT-001", text: "verified", status: "pending" }],
    facts: ["fact"],
    assumptions: ["assumption"],
    risks: ["risk"],
    blockers: ["blocker"],
    blockerHistory: [{ timestamp: "b", status: "active", reason: "blocker" }],
    doctrine: ["doctrine"],
    evidence: ["evidence"],
    pinnedEvidence: ["pinned evidence"],
    roleCheckpoints: [{ iteration: 2, role: "observer", status: "completed", timestamp: "r" }],
    reviews: [{ timestamp: "t", verdict: "not_ready", findings: ["gap"], unresolvedGaps: ["gap"], evidenceSummary: "checked" }],
    notes: [{ timestamp: "n", text: "note" }],
    iterations: [{ step: 1 }],
    nextAction: "continue",
  };
  const scaffold = { id: "default", body: "Do work", policy: { workflow: "worker", waitingAllowed: false } };
  const worker = buildGoalContextPacket(goal, scaffold, { role: "worker", action: "continue" });
  const observer = buildGoalContextPacket(goal, scaffold, { role: "observer", action: "inspect_current_state" });
  const reviewer = buildGoalContextPacket(goal, scaffold, { role: "reviewer", action: "terminal_review" });
  const strategic = buildGoalContextPacket(goal, scaffold, { role: "reviewer", action: "scheduled_strategic_review", scheduledReview: true });
  const audit = buildGoalContextPacket(goal, scaffold, { role: "custom", contextProfile: "audit" });

  assert.equal(worker.request.contextProfile, "worker");
  assert.deepEqual(worker.state.facts, ["fact"]);
  assert.equal(worker.state.latestReview, undefined);
  assert.equal(worker.state.recentIterations, undefined);
  assert.equal(worker.goal.id, undefined);
  assert.deepEqual(observer.state.recentIterations, [{ step: 1 }]);
  assert.equal(observer.state.facts, undefined);
  assert.equal(observer.criteria, undefined);
  assert.equal(reviewer.state.latestReview.verdict, "not_ready");
  assert.equal(reviewer.state.recentIterations, undefined);
  assert.deepEqual(strategic.state.recentIterations, [{ step: 1 }]);
  assert.deepEqual(audit.state.roleCheckpoints, goal.roleCheckpoints);
  assert.equal(audit.goal.id, "g1");
  assert.equal(worker.scaffold.body, "Do work");
  assert.equal(worker.scaffold.policy.waitingAllowed, false);
  assert.equal(worker.reportContractHint.lifecycleAuthority, "orchestrator");
  assert.equal(worker.request.priorRoleReports, undefined);
});

test("resolveGoalContextProfile uses safe role defaults", () => {
  assert.equal(resolveGoalContextProfile({ role: "observer" }), "observer");
  assert.equal(resolveGoalContextProfile({ role: "researcher" }), "researcher");
  assert.equal(resolveGoalContextProfile({ role: "reviewer", scheduledReview: true }), "strategicReviewer");
  assert.equal(resolveGoalContextProfile({ role: "reviewer" }), "completionReviewer");
  assert.equal(resolveGoalContextProfile({ role: "new-role" }), "worker");
  assert.equal(resolveGoalContextProfile({ role: "new-role", contextProfile: "audit" }), "audit");
  assert.equal(resolveGoalContextProfile({ role: "new-role", contextProfile: "unknown" }), "worker");
});

test("role context limits criteria to the current phase while strategic review sees all", () => {
  const goal = baseGoal({
    criteria: [
      { id: "CRIT-001", text: "Current", status: "pending" },
      { id: "CRIT-002", text: "Later", status: "pending" },
    ],
    phases: [
      { id: "one", title: "One", objective: "Current work", status: "active", criterionIds: ["CRIT-001"] },
      { id: "two", title: "Two", objective: "Later work", status: "pending", criterionIds: ["CRIT-002"] },
    ],
    currentPhaseId: "one",
  });
  const worker = buildGoalContextPacket(goal, undefined, { role: "worker" });
  const strategic = buildGoalContextPacket(goal, undefined, { role: "reviewer", scheduledReview: true });

  assert.deepEqual(worker.criteria.map((item) => item.id), ["CRIT-001"]);
  assert.deepEqual(strategic.criteria.map((item) => item.id), ["CRIT-001", "CRIT-002"]);
  assert.equal(worker.currentPhase.id, "one");
  assert.equal(worker.nextPhase, undefined);
  assert.equal(strategic.nextPhase.id, "two");
});

test("buildGoalContextPacket carries prior role reports for worker handoff", () => {
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
  const researcherReport = {
    schemaVersion: 1,
    role: "researcher",
    outcome: "progress",
    summary: "Use existing goal-core helpers for workflow state.",
    confidence: "high",
    actions: [{ summary: "Read goal-core workflow selection." }],
    evidence: [{ kind: "file", ref: "goal-core.mjs", status: "observed", summary: "Workflow helpers exist." }],
    findings: ["Research-worker should feed findings to worker through priorRoleReports."],
    openQuestions: [],
    nextAction: "Worker should implement using existing workflow helpers.",
  };
  const packet = buildGoalContextPacket(baseGoal(), { id: "default", policy: { workflow: "research-worker" } }, {
    role: "worker",
    action: "continue_after_research",
    workflow: "research-worker",
    workflowRoles: ["researcher", "worker"],
    priorRoleReports: [observerReport, researcherReport],
  });

  assert.equal(packet.request.role, "worker");
  assert.equal(packet.request.priorRoleReports[0].role, "observer");
  assert.equal(packet.request.priorRoleReports[1].role, "researcher");
  assert.match(packet.request.priorRoleReports[1].findings[0], /Research-worker/);
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

test("completionReadiness requires criteria evidence, reviewer assessment evidence, and ready terminal review", () => {
  const base = { status: "active", criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] };
  const terminalReview = { verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "proof", evidence: ["observation:goal state — observed: proof"], criteriaAssessment: [provenAssessment()] };
  assert.equal(completionReadiness(base).ready, false);
  assert.equal(completionReadiness({ ...base, reviews: [terminalReview] }).ready, true);
  assert.equal(completionReadiness({ ...base, reviews: [{ ...terminalReview, criteriaAssessment: [] }] }).ready, false);
  assert.match(completionReadiness({ ...base, reviews: [{ ...terminalReview, criteriaAssessment: [] }] }).missing.join("; "), /missing reviewer assessment/);
  assert.equal(completionReadiness({ ...base, status: "blocked", reviews: [terminalReview] }).ready, false);
});

test("completionReadiness rejects duplicate, unknown, and contradictory reviewer assessments", () => {
  const base = { status: "active", criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] };
  const review = { verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "proof", evidence: ["observation:goal state — observed: proof"] };
  assert.match(completionReadiness({ ...base, reviews: [{ ...review, criteriaAssessment: [provenAssessment(), provenAssessment()] }] }).missing.join("; "), /duplicate/);
  assert.match(completionReadiness({ ...base, reviews: [{ ...review, criteriaAssessment: [provenAssessment(), provenAssessment("CRIT-999")] }] }).missing.join("; "), /not a current criterion/);
  assert.match(completionReadiness({ ...base, reviews: [{ ...review, criteriaAssessment: [{ id: "CRIT-001", status: "contradicted", reason: "A failing check remains.", evidence: [evidence()] }] }] }).missing.join("; "), /contradicted/);
});

test("strategic reviews are distinguished from terminal completion reviews", () => {
  const base = { status: "active", criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] };
  const strategicOnly = {
    ...base,
    reviews: [{ kind: "strategic", verdict: "ready_to_complete", findings: ["May be ready."], evidenceSummary: "strategic check" }],
  };
  assert.equal(completionReadiness(strategicOnly).ready, false);
  assert.equal(latestTerminalReview(strategicOnly.reviews), undefined);

  const withTerminal = {
    ...strategicOnly,
    reviews: [...strategicOnly.reviews, { kind: "terminal", verdict: "ready_to_complete", findings: ["Ready."], evidenceSummary: "terminal check", evidence: ["observation:goal state — observed: terminal check"], criteriaAssessment: [provenAssessment()] }],
  };
  assert.equal(completionReadiness(withTerminal).ready, true);
  assert.equal(latestTerminalReview(withTerminal.reviews).evidenceSummary, "terminal check");
});

test("applyGoalAgentReport merges proposed durable state and evidence", () => {
  const merged = applyGoalAgentReport(baseGoal(), workerReport({
    recommendedDoctrine: ["Keep durable state compact and evidence-backed."],
    proposedState: {
      factsToAdd: ["Fact A"],
      assumptionsToAdd: ["Assumption A"],
      risksToAdd: ["Risk A"],
      blockersToAdd: ["Potential blocker A"],
      evidenceToAdd: [evidence("command", "npm test")],
      pinnedEvidenceToAdd: [evidence("artifact", "release-note")],
      checklist: [{ text: "Merge tested", done: true, evidence: "unit test" }],
    },
  }), {}, { now: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(merged.facts, ["Fact A"]);
  assert.deepEqual(merged.assumptions, ["Assumption A"]);
  assert.deepEqual(merged.risks, ["Risk A"]);
  assert.deepEqual(merged.blockers, ["Potential blocker A"]);
  assert.deepEqual(merged.doctrine, ["Keep durable state compact and evidence-backed."]);
  assert.equal(merged.checklist[0].done, true);
  assert.equal(merged.evidence.length, 2);
  assert.equal(merged.pinnedEvidence.length, 1);
  assert.equal(merged.blockerHistory[0].status, "potential");
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
  assert.equal(completionReadiness(merged).ready, false);
});

test("phase-gate reviewer advances only the immediate next phase", () => {
  const goal = baseGoal({
    criteria: [
      { id: "CRIT-001", text: "Plan complete", status: "passed", evidence: "plan proof" },
      { id: "CRIT-002", text: "Run complete", status: "pending" },
    ],
    phases: [
      { id: "plan", title: "Plan", objective: "Plan", status: "active", criterionIds: ["CRIT-001"] },
      { id: "run", title: "Run", objective: "Run", status: "pending", criterionIds: ["CRIT-002"] },
    ],
    currentPhaseId: "plan",
  });
  const advanced = applyGoalReviewerReport(goal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Plan gate passed.",
    confidence: "high",
    actions: [{ summary: "Reviewed plan." }],
    evidence: [evidence("observation", "plan gate")],
    verdict: "ready_to_complete",
    findings: ["Planning phase is complete."],
    criteriaAssessment: [provenAssessment("CRIT-001")],
    phaseTransition: { toPhaseId: "run", evidence: [evidence("observation", "transition")] },
  }, { reviewKind: "phase_gate" });
  assert.equal(advanced.status, "active");
  assert.equal(advanced.currentPhaseId, "run");
  assert.equal(advanced.phases[0].status, "passed");
  assert.equal(advanced.phases[1].status, "active");
  assert.equal(advanced.reviews.at(-1).kind, "phase_gate");
  assert.throws(() => applyGoalReviewerReport(goal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Wrong transition.",
    confidence: "high",
    actions: [],
    evidence: [evidence()],
    verdict: "ready_to_complete",
    findings: ["Wrong."],
    criteriaAssessment: [provenAssessment("CRIT-001")],
    phaseTransition: { toPhaseId: "plan" },
  }, { reviewKind: "phase_gate" }), /immediate next phase/);
});

test("applyGoalReviewerReport records strategic reviews without completing", () => {
  const readyGoal = baseGoal({ criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] });
  const strategic = applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Strategic review says terminal review may be warranted.",
    confidence: "medium",
    actions: [{ summary: "Reviewed strategy." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Evidence appears strong enough to request terminal review."],
    criteriaAssessment: [],
    nextAction: "Request terminal completion review.",
  }, { reviewKind: "strategic", now: "2026-01-01T00:00:00.000Z" });

  assert.equal(strategic.status, "active");
  assert.equal(strategic.reviews.at(-1).kind, "strategic");
  assert.equal(strategic.nextAction, "Request terminal completion review.");
  assert.equal(completionReadiness(strategic).ready, false);
});

test("applyGoalReviewerReport preserves structured manual not-ready reviews", () => {
  const reviewed = applyGoalReviewerReport(baseGoal(), {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "A gap remains.",
    confidence: "medium",
    actions: [],
    evidence: [evidence("observation", "goal state")],
    verdict: "not_ready",
    findings: ["Implementation needs one more check."],
    unresolvedGaps: ["Run the integration check."],
    criteriaAssessment: [],
  });

  assert.equal(reviewed.reviews.at(-1).kind, "terminal");
  assert.deepEqual(reviewed.reviews.at(-1).evidence, ["observation:goal state — passed: Proof."]);
  assert.deepEqual(reviewed.reviews.at(-1).criteriaAssessment, []);
  assert.equal(reviewed.nextAction, "Run the integration check.");
});

test("applyGoalReviewerReport rejects ready terminal reviews with incomplete criteria assessment", () => {
  const readyGoal = baseGoal({ criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] });
  assert.throws(() => applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Ready but missing assessment.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Looks ready."],
    criteriaAssessment: [],
  }), /criteriaAssessment is incomplete/);
  assert.throws(() => applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Ready but assessment lacks evidence.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Looks ready."],
    criteriaAssessment: [{ id: "CRIT-001", status: "proven", reason: "Looks proven." }],
  }), /missing evidence/);
});

test("completionReadiness rejects terminal reviews without structured reviewer evidence", () => {
  const readyGoal = baseGoal({ criteria: [{ id: "CRIT-001", text: "Done", status: "passed", evidence: "proof" }] });
  const reviewed = applyGoalReviewerReport(readyGoal, {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Ready but no top-level evidence.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [],
    verdict: "ready_to_complete",
    findings: ["Evidence sufficient."],
    criteriaAssessment: [provenAssessment()],
  });
  assert.equal(reviewed.status, "complete");

  const legacy = { ...readyGoal, reviews: [{ verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "prose only", criteriaAssessment: [provenAssessment()] }] };
  assert.equal(completionReadiness(legacy).ready, true);
  const noReviewerEvidence = { ...readyGoal, reviews: [{ verdict: "ready_to_complete", findings: ["ok"], evidenceSummary: "prose only", criteriaAssessment: [{ id: "CRIT-001", status: "proven", reason: "ok" }] }] };
  assert.equal(completionReadiness(noReviewerEvidence).ready, false);
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
    criteriaAssessment: [provenAssessment()],
  });
  assert.equal(ready.status, "complete");

  const reviewedPendingCriterion = applyGoalReviewerReport(baseGoal(), {
    schemaVersion: 1,
    role: "reviewer",
    outcome: "review_complete",
    summary: "Criterion is proven by terminal review.",
    confidence: "medium",
    actions: [{ summary: "Reviewed." }],
    evidence: [evidence("observation", "goal state")],
    verdict: "ready_to_complete",
    findings: ["Review says ready."],
    criteriaAssessment: [provenAssessment()],
  });
  assert.equal(reviewedPendingCriterion.status, "complete");
  assert.equal(reviewedPendingCriterion.criteria[0].status, "passed");
  assert.match(reviewedPendingCriterion.criteria[0].evidence, /criterion CRIT-001/);

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
    criteriaAssessment: [{ id: "CRIT-001", status: "not_proven", reason: "Docs were not updated." }],
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
  assert.equal(blocked.blockerHistory.at(-1).status, "active");
  assert.equal(blocked.blockerHistory.at(-1).needed, "User provides token");

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

test("validateGoalAgentReport accepts structured researcher reports", () => {
  assert.doesNotThrow(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "researcher",
    outcome: "progress",
    summary: "Existing workflow helpers support research-worker handoff.",
    confidence: "high",
    actions: [{
      summary: "Inspected workflow selection and context packet helpers.",
      evidence: [{ kind: "file", ref: "goal-core.mjs", status: "observed", summary: "Research-worker plan and priorRoleReports are represented." }],
    }],
    evidence: [{ kind: "file", ref: "goal-core.mjs", status: "observed", summary: "Source supports selected workflow roles." }],
    findings: ["Use priorRoleReports to pass research findings to the worker."],
    openQuestions: ["Whether future doctrine should become first-class durable state."],
    recommendedDoctrine: ["Researchers should only propose state changes through report fields."],
    proposedState: {
      factsToAdd: ["Research-worker workflow has a researcher role before the worker."],
      assumptionsToAdd: ["Report fields are sufficient for bounded doctrine until a durable doctrine store exists."],
      risksToAdd: ["Research findings may become stale if worker execution is delayed."],
    },
    nextAction: "Worker should implement the researched path.",
  }));
});

test("validateGoalAgentReport rejects researcher completion claims and evidence-free progress", () => {
  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "researcher",
    outcome: "ready_for_review",
    summary: "Looks complete.",
    confidence: "medium",
    actions: [],
    evidence: [{ kind: "observation", ref: "goal", summary: "Observed." }],
  }), /Researcher report outcome/);

  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "researcher",
    outcome: "progress",
    summary: "Found something.",
    confidence: "medium",
    actions: [{ summary: "Researched." }],
    evidence: [],
    findings: ["A finding."],
    nextAction: "Continue.",
  }), /research evidence/);
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

test("validateGoalAgentReport rejects malformed nested evidence", () => {
  assert.throws(() => validateGoalAgentReport({
    ...workerReport(),
    actions: [{ summary: "Changed files.", evidence: [{ kind: "unknown", ref: "x", summary: "bad" }] }],
  }), /actions\[0\]\.evidence\[0\]\.kind is invalid/);
  assert.throws(() => validateGoalAgentReport({
    ...workerReport(),
    proposedState: { evidenceToAdd: [{ kind: "test", ref: "x" }] },
  }), /proposedState\.evidenceToAdd\[0\]\.summary is required/);
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
