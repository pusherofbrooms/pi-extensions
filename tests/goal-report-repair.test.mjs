import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("delegated prompts share nested contract and schema repair is bounded and tool-free", async () => {
  const source = await readFile(new URL("../goal.ts", import.meta.url), "utf8");
  assert.match(source, /const GOAL_AGENT_REPORT_CONTRACT/);
  for (const role of ["worker", "observer", "researcher", "reviewer"]) {
    assert.match(source, new RegExp(`contract: reportContract\\("${role}"\\)`));
  }
  assert.match(source, /criteriaAssessment: .*evidence\?:Evidence\[\]/);
  assert.match(source, /phaseTransition: .*toPhaseId:string/);
  assert.match(source, /outcomesByRole/);
  assert.match(source, /criteriaUpdate: .*passed requires non-empty evidence/);
  assert.match(source, /isNonRetryableContinuationError\(error\)/);
  assert.match(source, /checkNoSecrets\(result\.text, "raw agent output"\)[\s\S]*?runIsolatedAgent/);
  assert.match(source, /Refusing secret-bearing malformed \$\{expectedRole\} report/);
  assert.match(source, /checkReportForSecrets\(report\).*NonRetryableReportError/);
  assert.match(source, /Existing output:/);
  assert.match(source, /Validator feedback:/);
  assert.match(source, /systemPromptPath, `Reformat[\s\S]*?`, \[\], deps, thinkingLevel, true\)/);
  assert.doesNotMatch(source, /for \([^)]*repair|while \([^)]*repair/);
  assert.match(source, /provenance\?: "primary" \| "repair"/);
  for (const role of ["worker", "observer", "researcher", "reviewer"]) {
    assert.match(source, new RegExp(`role: "${role}"[\\s\\S]{0,180}provenance: "repair"`));
  }
});
