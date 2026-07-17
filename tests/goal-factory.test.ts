import test from "node:test";
import assert from "node:assert/strict";
import { createStoredGoal, type CreateStoredGoalOptions } from "../goal-factory.ts";

const base: CreateStoredGoalOptions = {
  id: "2026-01-02T03-04-05-000Z_abc123",
  cwd: "/work/project",
  sessionFile: "/sessions/current.jsonl",
  objective: "Ship the objective",
  scaffold: "default",
  createdAt: "2026-01-02T03:04:06.000Z",
  updatedAt: "2026-01-02T03:04:07.000Z",
  noteTimestamp: "2026-01-02T03:04:08.000Z",
  noteText: "Goal created. Do not store secrets in goal notes.",
};

test("createStoredGoal supplies the complete new-goal defaults", () => {
  const goal = createStoredGoal(base);

  assert.deepEqual(goal, {
    version: 1,
    id: base.id,
    cwd: base.cwd,
    sessionFile: base.sessionFile,
    status: "active",
    objective: base.objective,
    scaffold: "default",
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    stepCount: 0,
    maxIterations: undefined,
    reviewEvery: undefined,
    summary: "Goal created. No progress yet.",
    checklist: [], criteria: [], reviews: [], facts: [], assumptions: [], risks: [], blockers: [],
    blockerHistory: [], doctrine: [], evidence: [], pinnedEvidence: [], iterations: [],
    nextAction: "Inspect the goal and choose the first concrete action.",
    notes: [{ timestamp: base.noteTimestamp, text: base.noteText }],
    continuationQueued: false,
  });
});

test("command and goal_start inputs retain their caller-specific construction values", () => {
  const commandGoal = createStoredGoal({ ...base, maxIterations: 12, reviewEvery: 3 });
  const toolGoal = createStoredGoal({
    ...base,
    objective: "Trimmed tool objective",
    scaffold: "zenith",
    maxIterations: 7,
    reviewEvery: 5,
    noteText: "Goal created via goal_start tool. Do not store secrets in goal notes.",
  });

  assert.deepEqual(
    { id: commandGoal.id, createdAt: commandGoal.createdAt, updatedAt: commandGoal.updatedAt, maxIterations: commandGoal.maxIterations, reviewEvery: commandGoal.reviewEvery, scaffold: commandGoal.scaffold, note: commandGoal.notes[0] },
    { id: base.id, createdAt: base.createdAt, updatedAt: base.updatedAt, maxIterations: 12, reviewEvery: 3, scaffold: "default", note: { timestamp: base.noteTimestamp, text: base.noteText } },
  );
  assert.deepEqual(
    { objective: toolGoal.objective, maxIterations: toolGoal.maxIterations, reviewEvery: toolGoal.reviewEvery, scaffold: toolGoal.scaffold, note: toolGoal.notes[0] },
    { objective: "Trimmed tool objective", maxIterations: 7, reviewEvery: 5, scaffold: "zenith", note: { timestamp: base.noteTimestamp, text: "Goal created via goal_start tool. Do not store secrets in goal notes." } },
  );
});
