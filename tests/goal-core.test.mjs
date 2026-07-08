import test from "node:test";
import assert from "node:assert/strict";
import {
  appendUniqueStrings,
  applyCriterionUpdates,
  blockedStatusFromReport,
  completionReadiness,
  mergeCriteria,
  normalizeCriteriaInputs,
  normalizeGoal,
  recommendScaffoldId,
  validateGoalAgentReport,
  validateReview,
  waitingStatusFromReport,
} from "../goal-core.mjs";

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
