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
  validateReview,
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
