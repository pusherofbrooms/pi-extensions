import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  GoalAgentReport,
  GoalIteration,
  GoalRoleCheckpoint,
  GoalRuntimeDeps,
  GoalScaffold,
  GoalSubagentRole,
  GoalSubagentSessionRef,
  StoredGoal,
} from "./goal-types.ts";
import {
  appendGoalRoleCheckpoint,
  applyGoalReviewerReport,
  currentGoalPhase,
  nextGoalPhase,
  selectGoalWorkflowPlan,
} from "./goal-core.mjs";
import { applyDelegatedReport, evidenceText } from "./goal-reports.ts";

const CONTINUATION_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
const MAX_STORED_ITERATIONS = 50;

type AgentRun = { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string };

export type GoalContinuationServices = {
  loadScaffold: (cwd: string, id?: string) => Promise<GoalScaffold>;
  runScheduledStrategicReview: (goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>, plan: ReturnType<typeof selectGoalWorkflowPlan>, deps: GoalRuntimeDeps) => Promise<AgentRun>;
  runGoalObserver: GoalContinuationServices["runScheduledStrategicReview"];
  runGoalResearcher: GoalContinuationServices["runScheduledStrategicReview"];
  runGoalWorker: (goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>, plan: ReturnType<typeof selectGoalWorkflowPlan>, prior: GoalAgentReport[], deps: GoalRuntimeDeps) => Promise<AgentRun>;
  runParentReview: (goal: StoredGoal, report: GoalAgentReport, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>, deps: GoalRuntimeDeps) => Promise<AgentRun>;
  updateStatus: (ctx: ExtensionContext, goal?: StoredGoal) => void;
  goalForModel: (goal: StoredGoal) => StoredGoal;
  goalPath: (id: string) => string;
  queueContinuation: (pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal) => void;
  checkNoSecrets: (value: string | undefined, label: string) => string | undefined;
};

export type GoalQueueServices = {
  isShuttingDown: () => boolean;
  getRuntime: () => StoredGoal | undefined;
  setRuntime: (goal: StoredGoal) => void;
  updateStatus: (ctx: ExtensionContext, goal?: StoredGoal) => void;
  readCurrentGoal: (cwd: string) => Promise<StoredGoal | undefined>;
  runDelegatedContinuation: (pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal) => Promise<void>;
  isNonRetryableContinuationError: (error: unknown) => boolean;
  nowMs: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
};

function appendGoalIteration(goal: StoredGoal, iteration: GoalIteration): StoredGoal {
  return { ...goal, iterations: [...(goal.iterations ?? []), iteration].slice(-MAX_STORED_ITERATIONS) };
}

function scheduledReviewDue(goal: StoredGoal): boolean {
  return !!goal.reviewEvery && goal.stepCount > 0 && goal.stepCount % goal.reviewEvery === 0 && goal.lastReviewStep !== goal.stepCount;
}

function roleCheckpointError(error: unknown, checkNoSecrets: GoalContinuationServices["checkNoSecrets"]): string {
  const message = (error as Error)?.message ?? String(error);
  return checkNoSecrets(message, "role failure") ? "Role failed; inspect its persisted session." : message.slice(0, 1000);
}

async function checkpointRole(
  goal: StoredGoal,
  role: GoalSubagentRole,
  status: GoalRoleCheckpoint["status"],
  details: { summary?: string; evidence?: string[]; sessionFile?: string; provenance?: "primary" | "repair"; error?: unknown },
  deps: GoalRuntimeDeps,
  checkNoSecrets: GoalContinuationServices["checkNoSecrets"],
): Promise<StoredGoal> {
  const checkpoint: GoalRoleCheckpoint = {
    iteration: goal.stepCount + 1,
    role,
    status,
    timestamp: deps.now(),
    summary: details.summary,
    evidence: details.evidence,
    sessionFile: details.sessionFile,
    provenance: details.provenance,
    error: details.error === undefined ? undefined : roleCheckpointError(details.error, checkNoSecrets),
  };
  return deps.writeGoal(appendGoalRoleCheckpoint(goal, checkpoint) as StoredGoal);
}

export async function runDelegatedContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal, deps: GoalRuntimeDeps, services: GoalContinuationServices): Promise<void> {
  const thinkingLevel = pi.getThinkingLevel();
  if (ctx.hasUI) ctx.ui.notify(`Running delegated goal step ${goal.stepCount + 1}...`, "info");
  const phase = currentGoalPhase(goal);
  const scaffold = await services.loadScaffold(ctx.cwd, phase?.scaffold ?? goal.scaffold ?? "default");
  const workflowPlan = selectGoalWorkflowPlan(scaffold);

  if (scheduledReviewDue(goal)) {
    if (ctx.hasUI) ctx.ui.notify("Running scheduled strategic goal review...", "info");
    let reviewRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string };
    try {
      reviewRun = await services.runScheduledStrategicReview(goal, scaffold, ctx, thinkingLevel, workflowPlan, deps);
    } catch (error) {
      await checkpointRole(goal, "reviewer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps, services.checkNoSecrets);
      throw error;
    }
    const strategicReview = reviewRun.report;
    const reviewedGoal = await checkpointRole(
      applyGoalReviewerReport(goal, strategicReview, { reviewKind: "strategic" }) as StoredGoal,
      "reviewer",
      "completed",
      { summary: strategicReview.summary, evidence: evidenceText(strategicReview.evidence), sessionFile: reviewRun.sessionFile, provenance: "primary" },
      deps,
      services.checkNoSecrets,
    );
    const reviewedGoalWithRepair = reviewRun.repairSessionFile
      ? await checkpointRole(reviewedGoal, "reviewer", "completed", { summary: "Report schema repair", sessionFile: reviewRun.repairSessionFile, provenance: "repair" }, deps, services.checkNoSecrets)
      : reviewedGoal;
    const nextStep = goal.stepCount + 1;
    const iterationTimestamp = deps.now();
    const sessionRefs: GoalSubagentSessionRef[] = [
      { role: "reviewer", timestamp: iterationTimestamp, sessionFile: reviewRun.sessionFile, provenance: "primary" },
      ...(reviewRun.repairSessionFile ? [{ role: "reviewer" as const, timestamp: iterationTimestamp, sessionFile: reviewRun.repairSessionFile, provenance: "repair" as const }] : []),
    ];
    const withIteration = appendGoalIteration(reviewedGoalWithRepair, {
      step: nextStep,
      timestamp: iterationTimestamp,
      roles: ["reviewer"],
      outcome: strategicReview.outcome,
      summary: strategicReview.summary,
      evidence: evidenceText(strategicReview.evidence ?? []),
      nextAction: reviewedGoal.nextAction,
      sessionRefs,
    });
    const reachedCap = reviewedGoal.maxIterations !== undefined && nextStep >= reviewedGoal.maxIterations;
    const updated = await deps.writeGoal({
      ...withIteration,
      status: reachedCap && reviewedGoal.status === "active" ? "paused" : reviewedGoal.status,
      stopReason: reachedCap && reviewedGoal.status === "active" ? "maxIterationsReached" : reviewedGoal.stopReason,
      stepCount: nextStep,
      continuationQueued: false,
    });
    services.updateStatus(ctx, updated);
    pi.sendMessage({ customType: "goal-strategic-review", content: `Scheduled strategic review: ${strategicReview.verdict}\n${strategicReview.commentary ?? strategicReview.summary}`, display: true, details: { strategicReview, goal: services.goalForModel(updated), path: services.goalPath(updated.id) } });
    if (reachedCap && updated.status === "paused") {
      ctx.ui.notify(`Goal paused after reaching max iterations (${updated.maxIterations}).`, "warning");
      return;
    }
    if (updated.status === "active") services.queueContinuation(pi, ctx, updated);
    return;
  }

  let observerRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string } | undefined;
  let afterObservation = goal;
  if (workflowPlan.roles[0] === "observer") {
    try {
      observerRun = await services.runGoalObserver(goal, scaffold, ctx, thinkingLevel, workflowPlan, deps);
      afterObservation = await checkpointRole(
        applyDelegatedReport(goal, observerRun.report, scaffold),
        "observer",
        "completed",
        { summary: observerRun.report.summary, evidence: evidenceText(observerRun.report.evidence), sessionFile: observerRun.sessionFile, provenance: "primary" },
        deps,
        services.checkNoSecrets,
      );
      if (observerRun.repairSessionFile) afterObservation = await checkpointRole(afterObservation, "observer", "completed", { summary: "Report schema repair", sessionFile: observerRun.repairSessionFile, provenance: "repair" }, deps, services.checkNoSecrets);
    } catch (error) {
      await checkpointRole(goal, "observer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps, services.checkNoSecrets);
      throw error;
    }
  }

  let researcherRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string } | undefined;
  let afterResearch = afterObservation;
  if (workflowPlan.roles[0] === "researcher") {
    try {
      researcherRun = await services.runGoalResearcher(afterObservation, scaffold, ctx, thinkingLevel, workflowPlan, deps);
      afterResearch = await checkpointRole(
        applyDelegatedReport(afterObservation, researcherRun.report, scaffold),
        "researcher",
        "completed",
        { summary: researcherRun.report.summary, evidence: evidenceText(researcherRun.report.evidence), sessionFile: researcherRun.sessionFile, provenance: "primary" },
        deps,
        services.checkNoSecrets,
      );
      if (researcherRun.repairSessionFile) afterResearch = await checkpointRole(afterResearch, "researcher", "completed", { summary: "Report schema repair", sessionFile: researcherRun.repairSessionFile, provenance: "repair" }, deps, services.checkNoSecrets);
    } catch (error) {
      await checkpointRole(afterObservation, "researcher", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps, services.checkNoSecrets);
      throw error;
    }
  }

  const priorRoleReports = [observerRun?.report, researcherRun?.report].filter(Boolean) as GoalAgentReport[];
  let workerRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string };
  try {
    workerRun = await services.runGoalWorker(afterResearch, scaffold, ctx, thinkingLevel, workflowPlan, priorRoleReports, deps);
  } catch (error) {
    await checkpointRole(afterResearch, "worker", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps, services.checkNoSecrets);
    throw error;
  }
  const report = workerRun.report;
  const afterReport = await checkpointRole(
    applyDelegatedReport(afterResearch, report, scaffold),
    "worker",
    "completed",
    { summary: report.summary, evidence: evidenceText(report.evidence), sessionFile: workerRun.sessionFile, provenance: "primary" },
    deps,
    services.checkNoSecrets,
  );
  const afterWorkerRepair = workerRun.repairSessionFile
    ? await checkpointRole(afterReport, "worker", "completed", { summary: "Report schema repair", sessionFile: workerRun.repairSessionFile, provenance: "repair" }, deps, services.checkNoSecrets)
    : afterReport;
  const nextStep = goal.stepCount + 1;

  let parentReview: GoalAgentReport | undefined;
  let parentReviewSessionFile: string | undefined;
  let parentReviewRepairSessionFile: string | undefined;
  let reviewedReport = afterWorkerRepair;
  let completed = false;

  if (report.outcome === "ready_for_review" && workflowPlan.reviewOnReady) {
    if (ctx.hasUI) ctx.ui.notify("Delegated worker proposed completion; running parent verification...", "info");
    try {
      const parentReviewRun = await services.runParentReview(afterWorkerRepair, report, scaffold, ctx, thinkingLevel, deps);
      parentReview = parentReviewRun.report;
      parentReviewSessionFile = parentReviewRun.sessionFile;
      parentReviewRepairSessionFile = parentReviewRun.repairSessionFile;
      reviewedReport = await checkpointRole(
        applyGoalReviewerReport(afterWorkerRepair, parentReview, { reviewKind: nextGoalPhase(afterWorkerRepair) ? "phase_gate" : "terminal" }) as StoredGoal,
        "reviewer",
        "completed",
        { summary: parentReview.summary, evidence: evidenceText(parentReview.evidence), sessionFile: parentReviewSessionFile, provenance: "primary" },
        deps,
        services.checkNoSecrets,
      );
      if (parentReviewRepairSessionFile) reviewedReport = await checkpointRole(reviewedReport, "reviewer", "completed", { summary: "Report schema repair", sessionFile: parentReviewRepairSessionFile, provenance: "repair" }, deps, services.checkNoSecrets);
      completed = reviewedReport.status === "complete";
    } catch (error) {
      await checkpointRole(afterWorkerRepair, "reviewer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps, services.checkNoSecrets);
      throw error;
    }
  } else if (report.outcome === "ready_for_review") {
    const gaps = [`Workflow '${workflowPlan.workflow}' does not run parent review automatically.`];
    reviewedReport = {
      ...afterReport,
      reviews: [...(afterReport.reviews ?? []), {
        timestamp: deps.now(),
        verdict: "not_ready" as const,
        findings: ["Programmatic readiness check rejected delegated completion before parent verification."],
        unresolvedGaps: gaps,
        evidenceSummary: `Delegated worker proposed review, but readiness gaps remain: ${gaps.join("; ")}`,
      }].slice(-20),
      nextAction: `Address readiness gaps before parent verification: ${gaps.join("; ")}`,
    };
  }

  const reachedCap = reviewedReport.maxIterations !== undefined && nextStep >= reviewedReport.maxIterations;
  const iterationTimestamp = deps.now();
  const sessionRefs: GoalSubagentSessionRef[] = [
    ...(observerRun ? [{ role: "observer" as const, timestamp: iterationTimestamp, sessionFile: observerRun.sessionFile, provenance: "primary" as const }] : []),
    ...(observerRun?.repairSessionFile ? [{ role: "observer" as const, timestamp: iterationTimestamp, sessionFile: observerRun.repairSessionFile, provenance: "repair" as const }] : []),
    ...(researcherRun ? [{ role: "researcher" as const, timestamp: iterationTimestamp, sessionFile: researcherRun.sessionFile, provenance: "primary" as const }] : []),
    ...(researcherRun?.repairSessionFile ? [{ role: "researcher" as const, timestamp: iterationTimestamp, sessionFile: researcherRun.repairSessionFile, provenance: "repair" as const }] : []),
    { role: "worker", timestamp: iterationTimestamp, sessionFile: workerRun.sessionFile, provenance: "primary" },
    ...(workerRun.repairSessionFile ? [{ role: "worker" as const, timestamp: iterationTimestamp, sessionFile: workerRun.repairSessionFile, provenance: "repair" as const }] : []),
    ...(parentReview || parentReviewSessionFile ? [{ role: "reviewer" as const, timestamp: iterationTimestamp, sessionFile: parentReviewSessionFile, provenance: "primary" as const }] : []),
    ...(parentReviewRepairSessionFile ? [{ role: "reviewer" as const, timestamp: iterationTimestamp, sessionFile: parentReviewRepairSessionFile, provenance: "repair" as const }] : []),
  ];
  const withIteration = appendGoalIteration(reviewedReport, {
    step: nextStep,
    timestamp: iterationTimestamp,
    roles: sessionRefs.map((ref) => ref.role),
    outcome: report.outcome,
    summary: report.summary,
    evidence: evidenceText([...(observerRun?.report.evidence ?? []), ...(researcherRun?.report.evidence ?? []), ...(report.evidence ?? [])]),
    nextAction: reviewedReport.nextAction,
    sessionRefs,
  });
  const updated = await deps.writeGoal({
    ...withIteration,
    status: completed ? "complete" : reachedCap && reviewedReport.status === "active" ? "paused" : reviewedReport.status,
    stopReason: completed ? reviewedReport.stopReason : reachedCap && reviewedReport.status === "active" ? "maxIterationsReached" : reviewedReport.stopReason,
    stepCount: nextStep,
    continuationQueued: false,
  });
  services.updateStatus(ctx, updated);

  const message = completed
    ? `Goal completed after parent verification.\n\n${parentReview?.commentary ?? report.summary}`
    : report.outcome === "ready_for_review"
      ? parentReview
        ? `Delegated worker proposed completion, but parent verification says not ready.\n\n${parentReview.commentary ?? parentReview.summary}\n\nGaps:\n${(parentReview.unresolvedGaps ?? []).map((item) => `- ${item}`).join("\n")}`
        : `Delegated worker thinks goal may be complete, but workflow '${workflowPlan.workflow}' does not run parent review automatically.`
      : `Delegated goal step ${nextStep}: ${report.outcome}\n${report.summary}`;
  pi.sendMessage({ customType: "goal-delegated-step", content: message, display: true, details: { observerReport: observerRun?.report, researcherReport: researcherRun?.report, report, parentReview, goal: services.goalForModel(updated), path: services.goalPath(updated.id) } });

  if (completed) return;
  if (reachedCap && updated.status === "paused") {
    ctx.ui.notify(`Goal paused after reaching max iterations (${updated.maxIterations}).`, "warning");
    return;
  }
  if (updated.status === "active") services.queueContinuation(pi, ctx, updated);
}

export function queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal, services: GoalQueueServices): void {
  if (services.isShuttingDown() || goal.status !== "active" || goal.continuationQueued) return;

  goal.continuationQueued = true;
  goal.lastContinuationAt = services.nowMs();
  services.setRuntime(goal);
  services.updateStatus(ctx, goal);

  const tryRun = async (attempt: number) => {
    const runtime = services.getRuntime();
    if (services.isShuttingDown() || runtime?.id !== goal.id || runtime.status !== "active") return;

    const retry = (error?: unknown) => {
      const delay = CONTINUATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        goal.continuationQueued = false;
        services.setRuntime(goal);
        const suffix = error ? `: ${(error as Error).message}` : ".";
        ctx.ui.notify(`Failed to run delegated goal continuation after retries${suffix}`, "error");
        return;
      }
      services.setTimeout(() => tryRun(attempt + 1), delay);
    };

    if (ctx.hasPendingMessages() || !ctx.isIdle()) {
      retry();
      return;
    }

    try {
      const current = await services.readCurrentGoal(ctx.cwd);
      if (!current || current.status !== "active") return;
      await services.runDelegatedContinuation(pi, ctx, current);
    } catch (error) {
      if (services.isNonRetryableContinuationError(error)) {
        goal.continuationQueued = false;
        services.setRuntime(goal);
        ctx.ui.notify(`Delegated continuation stopped without retry: ${(error as Error).message}`, "error");
        return;
      }
      retry(error);
    }
  };

  services.setTimeout(() => tryRun(0), 0);
}

