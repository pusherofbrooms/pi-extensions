import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGoalAgentReportShape, validateGoalAgentReport } from "../goal-core.mjs";

test("strict report validation rejects malformed nested actions", () => {
  assert.throws(() => validateGoalAgentReport({
    schemaVersion: 1,
    role: "worker",
    outcome: "progress",
    summary: "Work completed.",
    confidence: "high",
    actions: ["edited files"],
    evidence: [],
    nextAction: "Continue.",
  }), /action|summary/i);
});

test("safe action strings normalize locally and still receive strict final validation", () => {
  const normalized = normalizeGoalAgentReportShape({
    schemaVersion: 1,
    role: "worker",
    outcome: "progress",
    summary: "Work completed.",
    confidence: "high",
    actions: ["edited files"],
    evidence: [],
    nextAction: "Continue.",
  });
  assert.deepEqual(normalized.actions, [{ summary: "edited files" }]);
  assert.equal(validateGoalAgentReport(normalized), normalized);
  assert.throws(() => validateGoalAgentReport(normalizeGoalAgentReportShape({ ...normalized, confidence: "certain" })), /confidence/i);
});
