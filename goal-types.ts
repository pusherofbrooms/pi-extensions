import type { RunAgentSessionOptions, runAgentSession } from "./agent-runner.ts";

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "cleared";
export type GoalCriterionStatus = "pending" | "passed" | "failed";
export type GoalCriterion = { id: string; text: string; status: GoalCriterionStatus; evidence?: string; phaseId?: string };
export type GoalPhase = { id: string; title: string; objective: string; status: "pending" | "active" | "passed" | "blocked"; criterionIds: string[]; scaffold?: string; nextAction?: string };
export type GoalReviewVerdict = "ready_to_complete" | "not_ready" | "blocked";
export type GoalEvidenceRef = { kind: "command" | "file" | "test" | "url" | "session" | "observation" | "artifact"; ref: string; summary: string; status?: "passed" | "failed" | "observed" | "created" | "modified" | "not_run" };
export type GoalReview = { timestamp: string; kind?: "terminal" | "strategic" | "phase_gate"; verdict: GoalReviewVerdict; findings: string[]; unresolvedGaps?: string[]; evidenceSummary: string; evidence?: GoalEvidenceRef[]; criteriaAssessment?: GoalAgentReport["criteriaAssessment"] };
export type GoalChecklistItem = { text: string; done: boolean; evidence?: string };
export type GoalNoteEntry = { timestamp: string; text: string };
export type GoalBlockerHistoryEntry = { timestamp: string; status: "active" | "potential" | "resolved"; reason: string; needed?: string; evidence?: string[] };
export type GoalSubagentRole = "worker" | "reviewer" | "observer" | "researcher" | "experimenter";
export type GoalSubagentSessionRef = { role: GoalSubagentRole; timestamp: string; sessionFile?: string; provenance?: "primary" | "repair" };
export type GoalAgentOutcome = "progress" | "no_progress" | "waiting" | "blocked" | "ready_for_review" | "review_complete";
export type GoalAgentReport = {
  schemaVersion: 1; role: GoalSubagentRole; outcome: GoalAgentOutcome; summary: string; confidence: "low" | "medium" | "high";
  actions: { summary: string; evidence?: GoalEvidenceRef[] }[]; evidence: GoalEvidenceRef[];
  proposedState?: { factsToAdd?: string[]; assumptionsToAdd?: string[]; risksToAdd?: string[]; blockersToAdd?: string[]; evidenceToAdd?: GoalEvidenceRef[]; pinnedEvidenceToAdd?: GoalEvidenceRef[]; checklist?: GoalChecklistItem[] };
  criteriaUpdates?: { operation: "add" | "update_status"; id?: string; text?: string; status?: GoalCriterionStatus; evidence?: GoalEvidenceRef[]; phaseId?: string }[];
  blocker?: { reason: string; needed: string; evidence: GoalEvidenceRef[] }; wait?: { condition: string; resumeTrigger: string }; nextAction?: string;
  verdict?: "ready_to_complete" | "not_ready" | "blocked"; commentary?: string; findings?: string[]; unresolvedGaps?: string[];
  criteriaAssessment?: { id: string; status: "proven" | "not_proven" | "contradicted" | "missing_evidence"; reason: string; evidence?: GoalEvidenceRef[] }[];
  phaseTransition?: { toPhaseId: string; evidence?: GoalEvidenceRef[] }; scopeConcerns?: string[]; openQuestions?: string[]; recommendedDoctrine?: string[];
};
export type GoalRoleCheckpoint = { iteration: number; role: GoalSubagentRole; status: "completed" | "failed"; timestamp: string; summary?: string; evidence?: string[]; sessionFile?: string; provenance?: "primary" | "repair"; error?: string };
export type GoalIteration = { step: number; timestamp: string; roles: GoalSubagentSessionRef["role"][]; outcome: GoalAgentOutcome; summary: string; evidence: string[]; nextAction: string; sessionRefs: GoalSubagentSessionRef[] };
export type StoredGoal = {
  version: 1; id: string; cwd: string; sessionFile?: string; status: GoalStatus; objective: string; scaffold?: string; createdAt: string; updatedAt: string; stepCount: number; maxIterations?: number; stopReason?: string; summary: string;
  checklist: GoalChecklistItem[]; criteria?: GoalCriterion[]; phases?: GoalPhase[]; currentPhaseId?: string; reviews?: GoalReview[]; facts?: string[]; assumptions?: string[]; risks?: string[]; blockers?: string[]; blockerHistory?: GoalBlockerHistoryEntry[]; doctrine?: string[]; evidence?: string[]; pinnedEvidence?: string[]; roleCheckpoints?: GoalRoleCheckpoint[]; iterations?: GoalIteration[]; reviewEvery?: number; lastReviewStep?: number; nextAction: string; notes: GoalNoteEntry[]; continuationQueued?: boolean; lastContinuationAt?: number;
};
export type GoalIndex = { version: 1; byCwd: Record<string, string> };
export type ScaffoldPolicy = { goalShape?: string; workflow?: string; reviewEvery?: number; completionPolicy?: string; blockedPolicy?: string; waitingAllowed?: boolean; mergePolicy?: string };
export type GoalScaffold = { id: string; name: string; description: string; body: string; source: "bundled" | "user" | "project"; path?: string; policy: ScaffoldPolicy };
export type GoalRuntimeDeps = { runAgent: (options: RunAgentSessionOptions) => ReturnType<typeof runAgentSession>; now: () => string; writeGoal: (goal: StoredGoal) => Promise<StoredGoal> };
