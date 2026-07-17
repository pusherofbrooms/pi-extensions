import type { StoredGoal } from "./goal-types.ts";

export type CreateStoredGoalOptions = {
  id: string;
  cwd: string;
  sessionFile?: string;
  objective: string;
  scaffold: string;
  createdAt: string;
  updatedAt: string;
  noteTimestamp: string;
  noteText: string;
  maxIterations?: number;
  reviewEvery?: number;
};

export function createStoredGoal(options: CreateStoredGoalOptions): StoredGoal {
  return {
    version: 1,
    id: options.id,
    cwd: options.cwd,
    sessionFile: options.sessionFile,
    status: "active",
    objective: options.objective,
    scaffold: options.scaffold,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
    stepCount: 0,
    maxIterations: options.maxIterations,
    reviewEvery: options.reviewEvery,
    summary: "Goal created. No progress yet.",
    checklist: [],
    criteria: [],
    reviews: [],
    facts: [],
    assumptions: [],
    risks: [],
    blockers: [],
    blockerHistory: [],
    doctrine: [],
    evidence: [],
    pinnedEvidence: [],
    iterations: [],
    nextAction: "Inspect the goal and choose the first concrete action.",
    notes: [{ timestamp: options.noteTimestamp, text: options.noteText }],
    continuationQueued: false,
  };
}
