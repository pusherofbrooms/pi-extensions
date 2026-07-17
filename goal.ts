import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentSession } from "./agent-runner.ts";
import { detectSecret } from "./secret-detection.mjs";
import { createStoredGoal } from "./goal-factory.ts";
import { atomicWriteJson, withPersistenceLock } from "./goal-persistence.mjs";
import { listScaffolds as listScaffoldsFromDirectories, loadScaffold as loadScaffoldFromDirectories, parseFrontmatter, scaffoldPolicyText } from "./goal-scaffolds.ts";
import type { GoalAgentReport, GoalCriterion, GoalIndex, GoalIteration, GoalRoleCheckpoint, GoalRuntimeDeps, GoalScaffold, GoalStatus, GoalSubagentRole, GoalSubagentSessionRef, StoredGoal } from "./goal-types.ts";
import { appendGoalRoleCheckpoint, applyCriterionUpdates, applyGoalReviewerReport, buildGoalContextPacket, completionReadiness, currentGoalPhase, isTerminalGoal, nextGoalPhase, normalizeCriteriaInputs, normalizeGoal, normalizePhases, recommendScaffoldId, selectGoalWorkflowPlan, validateGoalAgentReport } from "./goal-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDelegatedReport, checkReportForSecrets, evidenceText, isNonRetryableContinuationError } from "./goal-reports.ts";
import { runGoalObserver, runGoalResearcher, runGoalWorker, runParentReview, runScheduledStrategicReview } from "./goal-agents.ts";
export { NonRetryableReportError, isNonRetryableContinuationError } from "./goal-reports.ts";
export { delegatedPrompt, observerPrompt, researcherPrompt, strategicReviewPrompt, parentReviewPrompt, parseOrRepairGoalAgentReport, runIsolatedAgent, runGoalObserver, runGoalResearcher, runGoalWorker, runScheduledStrategicReview, runParentReview } from "./goal-agents.ts";

const MAX_OBJECTIVE_CHARS = 4000;
const CONTINUATION_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
const MAX_STORED_ITERATIONS = 50;
const MODULE_DIR = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(getAgentDir(), "goals");
const GOALS_DIR = join(STORE_DIR, "goals");
const BUNDLED_SCAFFOLDS_DIR = join(MODULE_DIR, "scaffolds");
const USER_SCAFFOLDS_DIR = join(getAgentDir(), "scaffolds");
const PROJECT_SCAFFOLDS_DIR = join(CONFIG_DIR_NAME, "scaffolds");
const INDEX_PATH = join(STORE_DIR, "index.json");

let runtime: StoredGoal | undefined;
let shuttingDown = false;

export type { GoalRuntimeDeps } from "./goal-types.ts";

const DEFAULT_GOAL_RUNTIME_DEPS: GoalRuntimeDeps = {
  runAgent: runAgentSession,
  now: nowIso,
  writeGoal,
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const stamp = nowIso().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${suffix}`;
}

function goalPath(id: string): string {
  return join(GOALS_DIR, `${id}.json`);
}

async function ensureStore(): Promise<void> {
  await mkdir(GOALS_DIR, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function scaffoldDirectories(cwd: string) {
  return { bundled: BUNDLED_SCAFFOLDS_DIR, user: USER_SCAFFOLDS_DIR, project: join(cwd, PROJECT_SCAFFOLDS_DIR) };
}

function loadScaffold(cwd: string, id = "default"): Promise<GoalScaffold> {
  return loadScaffoldFromDirectories(scaffoldDirectories(cwd), id);
}

function listScaffolds(cwd: string): Promise<GoalScaffold[]> {
  return listScaffoldsFromDirectories(scaffoldDirectories(cwd));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureStore();
  await atomicWriteJson(path, value);
}

async function readIndex(): Promise<GoalIndex> {
  return (await readJson<GoalIndex>(INDEX_PATH)) ?? { version: 1, byCwd: {} };
}

async function writeIndex(index: GoalIndex): Promise<void> {
  await writeJson(INDEX_PATH, index);
}

async function setCurrentGoalId(cwd: string, id: string): Promise<void> {
  const index = await readIndex();
  index.byCwd[cwd] = id;
  await writeIndex(index);
}

async function getCurrentGoalId(cwd: string): Promise<string | undefined> {
  return (await readIndex()).byCwd[cwd];
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCreateArgs(args: string): { objective: string; maxIterations?: number } {
  const trimmed = args.trim();
  const match = trimmed.match(/^--max\s+(\d+)\s+([\s\S]+)$/);
  if (!match) return { objective: trimmed };
  return { maxIterations: Number.parseInt(match[1], 10), objective: match[2].trim() };
}

function extendMaxIterations(goal: StoredGoal, additionalIterations: number): StoredGoal {
  const currentCap = goal.maxIterations ?? goal.stepCount;
  return {
    ...goal,
    status: goal.status === "paused" && goal.stopReason === "maxIterationsReached" ? "active" : goal.status,
    stopReason: goal.stopReason === "maxIterationsReached" ? undefined : goal.stopReason,
    maxIterations: Math.max(goal.stepCount, currentCap) + additionalIterations,
    continuationQueued: false,
  };
}

async function readGoalById(id: string): Promise<StoredGoal | undefined> {
  const goal = await readJson<StoredGoal>(goalPath(id));
  return goal ? normalizeGoal(goal) as StoredGoal : undefined;
}

async function readCurrentGoal(cwd: string): Promise<StoredGoal | undefined> {
  const id = await getCurrentGoalId(cwd);
  if (!id) return undefined;
  const goal = await readGoalById(id);
  if (!goal) return undefined;
  return { ...goal, continuationQueued: runtime?.id === goal.id ? runtime.continuationQueued : false };
}

async function writeGoal(goal: StoredGoal): Promise<StoredGoal> {
  const next: StoredGoal = { ...goal, updatedAt: nowIso() };
  await writeJson(goalPath(next.id), next);
  await setCurrentGoalId(next.cwd, next.id);
  runtime = next;
  return next;
}

async function mutateCurrentGoal(cwd: string, mutator: (goal: StoredGoal) => StoredGoal): Promise<StoredGoal | undefined> {
  return withPersistenceLock(cwd, async () => {
    const current = await readCurrentGoal(cwd);
    if (!current) return undefined;
    return writeGoal(mutator(current));
  });
}

async function reloadRuntime(ctx: ExtensionContext): Promise<StoredGoal | undefined> {
  const goal = await readCurrentGoal(ctx.cwd);
  runtime = goal;
  updateStatus(ctx, goal);
  return goal;
}

function goalSummary(goal: StoredGoal): string {
  return [
    `Goal ${goal.status}: ${goal.objective}`,
    `Goal file: ${goalPath(goal.id)}`,
    `Scaffold: ${goal.scaffold ?? "default"}`,
    `Step count: ${goal.stepCount}${goal.maxIterations ? ` / ${goal.maxIterations}` : ""}`,
    goal.stopReason ? `Stop reason: ${goal.stopReason}` : undefined,
    goal.summary ? `Summary: ${goal.summary}` : undefined,
    goal.nextAction ? `Next action: ${goal.nextAction}` : undefined,
  ].filter(Boolean).join("\n");
}

function goalForModel(goal: StoredGoal): StoredGoal {
  const { continuationQueued: _queued, lastContinuationAt: _last, ...safeGoal } = goal;
  return safeGoal;
}

function appendGoalIteration(goal: StoredGoal, iteration: GoalIteration): StoredGoal {
  return { ...goal, iterations: [...(goal.iterations ?? []), iteration].slice(-MAX_STORED_ITERATIONS) };
}

function renderGoalForModel(goal: StoredGoal): string {
  const criteria = goal.criteria?.length
    ? goal.criteria.map((item) => `- [${item.status === "passed" ? "x" : item.status === "failed" ? "!" : " "}] ${item.id}: ${item.text}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")
    : "- No success criteria recorded yet.";
  const structured = [
    ["Facts", goal.facts],
    ["Assumptions", goal.assumptions],
    ["Risks", goal.risks],
    ["Blockers", goal.blockers],
    ["Doctrine", goal.doctrine],
    ["Pinned evidence", goal.pinnedEvidence],
    ["Evidence", goal.evidence],
  ].map(([label, values]) => `${label}:\n${(values as string[] | undefined)?.length ? (values as string[]).map((value) => `- ${value}`).join("\n") : "- None recorded."}`).join("\n\n");
  const latestReview = goal.reviews?.at(-1);
  const reviewText = latestReview
    ? `${latestReview.timestamp}: ${latestReview.verdict}\nEvidence: ${latestReview.evidenceSummary}${latestReview.unresolvedGaps?.length ? `\nUnresolved gaps:\n${latestReview.unresolvedGaps.map((gap) => `- ${gap}`).join("\n")}` : ""}`
    : "No reviews recorded yet.";
  const checklist = goal.checklist.length
    ? goal.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")
    : "- [ ] No checklist items recorded yet.";
  const notes = goal.notes.length
    ? goal.notes.slice(-8).map((note) => `- ${note.timestamp}: ${note.text}`).join("\n")
    : "- No notes recorded yet.";
  const phases = goal.phases?.length
    ? goal.phases.map((phase) => `${phase.id} [${phase.status}] ${phase.title}${phase.id === goal.currentPhaseId ? " (CURRENT)" : ""}${phase.objective ? ` — ${phase.objective}` : ""}`).join("\n")
    : "- No phases defined.";

  return `${goalSummary(goal)}\n\nCurrent phase:\n${goal.currentPhaseId ?? "none"}\n\nPhases:\n${phases}\n\nSuccess criteria:\n${criteria}\n\n${structured}\n\nChecklist:\n${checklist}\n\nLatest review:\n${reviewText}\n\nRecent notes:\n${notes}`;
}

function updateStatus(ctx: ExtensionContext, goal?: StoredGoal): void {
  if (!goal || goal.status === "complete" || goal.status === "cleared") {
    ctx.ui.setStatus("goal", "");
    return;
  }
  const cap = goal.maxIterations ? `/${goal.maxIterations}` : "";
  ctx.ui.setStatus("goal", `goal: ${goal.status} ${goal.stepCount}${cap}`);
}

function scheduledReviewDue(goal: StoredGoal): boolean {
  return !!goal.reviewEvery && goal.stepCount > 0 && goal.stepCount % goal.reviewEvery === 0 && goal.lastReviewStep !== goal.stepCount;
}

function roleCheckpointError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return checkNoSecrets(message, "role failure") ? "Role failed; inspect its persisted session." : message.slice(0, 1000);
}

async function checkpointRole(
  goal: StoredGoal,
  role: GoalSubagentRole,
  status: GoalRoleCheckpoint["status"],
  details: { summary?: string; evidence?: string[]; sessionFile?: string; provenance?: "primary" | "repair"; error?: unknown },
  deps: GoalRuntimeDeps,
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
    error: details.error === undefined ? undefined : roleCheckpointError(details.error),
  };
  return deps.writeGoal(appendGoalRoleCheckpoint(goal, checkpoint) as StoredGoal);
}

export async function runDelegatedContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal, deps: GoalRuntimeDeps = DEFAULT_GOAL_RUNTIME_DEPS): Promise<void> {
  const thinkingLevel = pi.getThinkingLevel();
  if (ctx.hasUI) ctx.ui.notify(`Running delegated goal step ${goal.stepCount + 1}...`, "info");
  const phase = currentGoalPhase(goal);
  const scaffold = await loadScaffold(ctx.cwd, phase?.scaffold ?? goal.scaffold ?? "default");
  const workflowPlan = selectGoalWorkflowPlan(scaffold);

  if (scheduledReviewDue(goal)) {
    if (ctx.hasUI) ctx.ui.notify("Running scheduled strategic goal review...", "info");
    let reviewRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string };
    try {
      reviewRun = await runScheduledStrategicReview(goal, scaffold, ctx, thinkingLevel, workflowPlan, deps);
    } catch (error) {
      await checkpointRole(goal, "reviewer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps);
      throw error;
    }
    const strategicReview = reviewRun.report;
    const reviewedGoal = await checkpointRole(
      applyGoalReviewerReport(goal, strategicReview, { reviewKind: "strategic" }) as StoredGoal,
      "reviewer",
      "completed",
      { summary: strategicReview.summary, evidence: evidenceText(strategicReview.evidence), sessionFile: reviewRun.sessionFile, provenance: "primary" },
      deps,
    );
    const reviewedGoalWithRepair = reviewRun.repairSessionFile
      ? await checkpointRole(reviewedGoal, "reviewer", "completed", { summary: "Report schema repair", sessionFile: reviewRun.repairSessionFile, provenance: "repair" }, deps)
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
    updateStatus(ctx, updated);
    pi.sendMessage({ customType: "goal-strategic-review", content: `Scheduled strategic review: ${strategicReview.verdict}\n${strategicReview.commentary ?? strategicReview.summary}`, display: true, details: { strategicReview, goal: goalForModel(updated), path: goalPath(updated.id) } });
    if (reachedCap && updated.status === "paused") {
      ctx.ui.notify(`Goal paused after reaching max iterations (${updated.maxIterations}).`, "warning");
      return;
    }
    if (updated.status === "active") queueContinuation(pi, ctx, updated);
    return;
  }

  let observerRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string } | undefined;
  let afterObservation = goal;
  if (workflowPlan.roles[0] === "observer") {
    try {
      observerRun = await runGoalObserver(goal, scaffold, ctx, thinkingLevel, workflowPlan, deps);
      afterObservation = await checkpointRole(
        applyDelegatedReport(goal, observerRun.report, scaffold),
        "observer",
        "completed",
        { summary: observerRun.report.summary, evidence: evidenceText(observerRun.report.evidence), sessionFile: observerRun.sessionFile, provenance: "primary" },
        deps,
      );
      if (observerRun.repairSessionFile) afterObservation = await checkpointRole(afterObservation, "observer", "completed", { summary: "Report schema repair", sessionFile: observerRun.repairSessionFile, provenance: "repair" }, deps);
    } catch (error) {
      await checkpointRole(goal, "observer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps);
      throw error;
    }
  }

  let researcherRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string } | undefined;
  let afterResearch = afterObservation;
  if (workflowPlan.roles[0] === "researcher") {
    try {
      researcherRun = await runGoalResearcher(afterObservation, scaffold, ctx, thinkingLevel, workflowPlan, deps);
      afterResearch = await checkpointRole(
        applyDelegatedReport(afterObservation, researcherRun.report, scaffold),
        "researcher",
        "completed",
        { summary: researcherRun.report.summary, evidence: evidenceText(researcherRun.report.evidence), sessionFile: researcherRun.sessionFile, provenance: "primary" },
        deps,
      );
      if (researcherRun.repairSessionFile) afterResearch = await checkpointRole(afterResearch, "researcher", "completed", { summary: "Report schema repair", sessionFile: researcherRun.repairSessionFile, provenance: "repair" }, deps);
    } catch (error) {
      await checkpointRole(afterObservation, "researcher", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps);
      throw error;
    }
  }

  const priorRoleReports = [observerRun?.report, researcherRun?.report].filter(Boolean) as GoalAgentReport[];
  let workerRun: { report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string };
  try {
    workerRun = await runGoalWorker(afterResearch, scaffold, ctx, thinkingLevel, workflowPlan, priorRoleReports, deps);
  } catch (error) {
    await checkpointRole(afterResearch, "worker", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps);
    throw error;
  }
  const report = workerRun.report;
  const afterReport = await checkpointRole(
    applyDelegatedReport(afterResearch, report, scaffold),
    "worker",
    "completed",
    { summary: report.summary, evidence: evidenceText(report.evidence), sessionFile: workerRun.sessionFile, provenance: "primary" },
    deps,
  );
  const afterWorkerRepair = workerRun.repairSessionFile
    ? await checkpointRole(afterReport, "worker", "completed", { summary: "Report schema repair", sessionFile: workerRun.repairSessionFile, provenance: "repair" }, deps)
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
      const parentReviewRun = await runParentReview(afterWorkerRepair, report, scaffold, ctx, thinkingLevel, deps);
      parentReview = parentReviewRun.report;
      parentReviewSessionFile = parentReviewRun.sessionFile;
      parentReviewRepairSessionFile = parentReviewRun.repairSessionFile;
      reviewedReport = await checkpointRole(
        applyGoalReviewerReport(afterWorkerRepair, parentReview, { reviewKind: nextGoalPhase(afterWorkerRepair) ? "phase_gate" : "terminal" }) as StoredGoal,
        "reviewer",
        "completed",
        { summary: parentReview.summary, evidence: evidenceText(parentReview.evidence), sessionFile: parentReviewSessionFile, provenance: "primary" },
        deps,
      );
      if (parentReviewRepairSessionFile) reviewedReport = await checkpointRole(reviewedReport, "reviewer", "completed", { summary: "Report schema repair", sessionFile: parentReviewRepairSessionFile, provenance: "repair" }, deps);
      completed = reviewedReport.status === "complete";
    } catch (error) {
      await checkpointRole(afterWorkerRepair, "reviewer", "failed", { error, sessionFile: (error as Error & { sessionFile?: string }).sessionFile }, deps);
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
  updateStatus(ctx, updated);

  const message = completed
    ? `Goal completed after parent verification.\n\n${parentReview?.commentary ?? report.summary}`
    : report.outcome === "ready_for_review"
      ? parentReview
        ? `Delegated worker proposed completion, but parent verification says not ready.\n\n${parentReview.commentary ?? parentReview.summary}\n\nGaps:\n${(parentReview.unresolvedGaps ?? []).map((item) => `- ${item}`).join("\n")}`
        : `Delegated worker thinks goal may be complete, but workflow '${workflowPlan.workflow}' does not run parent review automatically.`
      : `Delegated goal step ${nextStep}: ${report.outcome}\n${report.summary}`;
  pi.sendMessage({ customType: "goal-delegated-step", content: message, display: true, details: { observerReport: observerRun?.report, researcherReport: researcherRun?.report, report, parentReview, goal: goalForModel(updated), path: goalPath(updated.id) } });

  if (completed) return;
  if (reachedCap && updated.status === "paused") {
    ctx.ui.notify(`Goal paused after reaching max iterations (${updated.maxIterations}).`, "warning");
    return;
  }
  if (updated.status === "active") queueContinuation(pi, ctx, updated);
}

function queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): void {
  if (shuttingDown || goal.status !== "active" || goal.continuationQueued) return;

  goal.continuationQueued = true;
  goal.lastContinuationAt = Date.now();
  runtime = goal;
  updateStatus(ctx, goal);

  const tryRun = async (attempt: number) => {
    if (shuttingDown || runtime?.id !== goal.id || runtime.status !== "active") return;

    const retry = (error?: unknown) => {
      const delay = CONTINUATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        goal.continuationQueued = false;
        runtime = goal;
        const suffix = error ? `: ${(error as Error).message}` : ".";
        ctx.ui.notify(`Failed to run delegated goal continuation after retries${suffix}`, "error");
        return;
      }
      setTimeout(() => tryRun(attempt + 1), delay);
    };

    if (ctx.hasPendingMessages() || !ctx.isIdle()) {
      retry();
      return;
    }

    try {
      const current = await readCurrentGoal(ctx.cwd);
      if (!current || current.status !== "active") return;
      await runDelegatedContinuation(pi, ctx, current);
    } catch (error) {
      if (isNonRetryableContinuationError(error)) {
        goal.continuationQueued = false;
        runtime = goal;
        ctx.ui.notify(`Delegated continuation stopped without retry: ${(error as Error).message}`, "error");
        return;
      }
      retry(error);
    }
  };

  setTimeout(() => tryRun(0), 0);
}

function checkNoSecrets(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const match = detectSecret(value);
  return match ? `${label} contains a possible secret (${match})` : undefined;
}

function goalHelp(): string {
  return `Goal commands:
/goal <objective>                    Start or replace the active project goal.
/goal --max <n> <objective>          Start a goal with an iteration cap.
/goal | /goal status                 Show current goal state.
/goal help                           Show this help.
/goal pause                          Pause autonomous continuation.
/goal resume                         Resume and queue continuation.
/goal clear                          Clear/abandon the current goal.
/goal complete                       Manually mark the goal complete.
/goal max <n|none>                   Set or clear the iteration cap.
/goal more <n> | /goal --more <n>    Add N iterations to the cap; resumes if cap-paused.
/goal review-every <n|none>          Enable or disable periodic strategic reviews.
/goal scaffolds                       List available scaffolds.
/goal scaffold <id>                   Set scaffold for current/future continuations.
/goal scaffold status                 Show current scaffold.

Model tools for long-horizon goals:
get_goal, goal_inspect_session, goal_note, goal_criteria, goal_criterion_update, goal_review, goal_block, update_goal.`;
}

export default function goalExtension(pi: ExtensionAPI) {
  pi.registerEntryRenderer("goal-command", (entry) => {
    const text = typeof entry.data === "object" && entry.data !== null && "text" in entry.data
      ? String(entry.data.text ?? "")
      : "";
    return new UserMessageComponent(text);
  });

  pi.registerCommand("goal", {
    description: "Set, inspect, pause, resume, clear, or complete a tool-backed autonomous goal.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const commandText = `/goal${trimmed ? ` ${trimmed}` : ""}`;
      if (!checkNoSecrets(commandText, "Goal command")) {
        pi.appendEntry("goal-command", { text: commandText });
      }
      const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase();

      if (!trimmed || subcommand === "status") {
        const goal = await reloadRuntime(ctx);
        ctx.ui.notify(goal ? goalSummary(goal) : "No current goal found.", goal ? "info" : "warning");
        return;
      }

      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        ctx.ui.notify(goalHelp(), "info");
        return;
      }

      if (subcommand === "scaffolds") {
        const scaffolds = await listScaffolds(ctx.cwd);
        ctx.ui.notify(scaffolds.map((item) => `${item.id} (${item.source}) — ${item.description}\n  ${scaffoldPolicyText(item).replace(/\n/g, "\n  ")}`).join("\n"), "info");
        return;
      }

      if (subcommand === "scaffold") {
        const value = trimmed.slice("scaffold".length).trim();
        const current = await reloadRuntime(ctx);
        if (!current) {
          ctx.ui.notify("No current goal found.", "warning");
          return;
        }
        if (!value || value === "status") {
          const scaffold = await loadScaffold(ctx.cwd, current.scaffold ?? "default");
          ctx.ui.notify(`Current scaffold: ${scaffold.id} (${scaffold.source})\n${scaffold.description}\n${scaffoldPolicyText(scaffold)}`, "info");
          return;
        }
        const scaffold = await loadScaffold(ctx.cwd, value);
        if (scaffold.source === "bundled" && scaffold.id === "default" && value !== "default") {
          ctx.ui.notify(`Scaffold not found: ${value}`, "warning");
          return;
        }
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, scaffold: value, continuationQueued: false }));
        updateStatus(ctx, goal);
        ctx.ui.notify(`Goal scaffold set to ${scaffold.id} (${scaffold.source}).`, "info");
        return;
      }

      if (subcommand === "pause" || subcommand === "complete" || subcommand === "clear") {
        const status = (subcommand === "clear" ? "cleared" : subcommand === "pause" ? "paused" : subcommand) as GoalStatus;
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
          ...current,
          status,
          stopReason: status === "cleared" ? "clearedByUser" : status === "paused" ? "pausedByUser" : current.stopReason,
          continuationQueued: false,
        }));
        updateStatus(ctx, goal);
        ctx.ui.notify(goal ? `Goal marked ${status}.` : "No current goal found.", goal ? "info" : "warning");
        return;
      }

      if (subcommand === "resume") {
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
          ...current,
          status: "active",
          stopReason: undefined,
          continuationQueued: false,
        }));
        if (!goal) {
          ctx.ui.notify("No current goal found to resume.", "warning");
          return;
        }
        updateStatus(ctx, goal);
        ctx.ui.notify("Goal resumed; queuing continuation.", "info");
        queueContinuation(pi, ctx, goal);
        return;
      }

      if (subcommand === "more" || subcommand === "--more") {
        const value = trimmed.slice(subcommand.length).trim();
        const additionalIterations = parsePositiveInt(value);
        if (!additionalIterations) {
          ctx.ui.notify("Usage: /goal more <positive-number>", "warning");
          return;
        }
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => extendMaxIterations(current, additionalIterations));
        updateStatus(ctx, goal);
        if (!goal) {
          ctx.ui.notify("No current goal found.", "warning");
          return;
        }
        ctx.ui.notify(`Goal max iterations extended to ${goal.maxIterations}.`, "info");
        if (goal.status === "active") queueContinuation(pi, ctx, goal);
        return;
      }

      if (subcommand === "max") {
        const value = trimmed.slice(3).trim().toLowerCase();
        const maxIterations = value === "none" ? undefined : parsePositiveInt(value);
        if (value !== "none" && !maxIterations) {
          ctx.ui.notify("Usage: /goal max <positive-number|none>", "warning");
          return;
        }
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, maxIterations, continuationQueued: false }));
        updateStatus(ctx, goal);
        ctx.ui.notify(goal ? `Goal max iterations ${maxIterations ?? "cleared"}.` : "No current goal found.", goal ? "info" : "warning");
        return;
      }

      if (subcommand === "review-every") {
        const value = trimmed.slice("review-every".length).trim().toLowerCase();
        const reviewEvery = value === "none" ? undefined : parsePositiveInt(value);
        if (value !== "none" && !reviewEvery) {
          ctx.ui.notify("Usage: /goal review-every <positive-number|none>", "warning");
          return;
        }
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, reviewEvery, continuationQueued: false }));
        updateStatus(ctx, goal);
        ctx.ui.notify(goal ? `Goal review interval ${reviewEvery ?? "cleared"}.` : "No current goal found.", goal ? "info" : "warning");
        return;
      }

      const { objective, maxIterations } = parseCreateArgs(trimmed);
      if (!objective) {
        ctx.ui.notify("Usage: /goal <objective>", "warning");
        return;
      }
      if (objective.length > MAX_OBJECTIVE_CHARS) {
        ctx.ui.notify(`Goal objective is too long (${objective.length}/${MAX_OBJECTIVE_CHARS} chars).`, "warning");
        return;
      }
      const secretError = checkNoSecrets(objective, "Goal objective");
      if (secretError) {
        ctx.ui.notify(`Refusing to store goal objective: ${secretError}.`, "warning");
        return;
      }

      const scaffold = await loadScaffold(ctx.cwd, "default");
      const goal = await writeGoal(createStoredGoal({
        id: makeId(),
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        objective,
        scaffold: scaffold.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        noteTimestamp: nowIso(),
        noteText: "Goal created. Do not store secrets in goal notes.",
        maxIterations,
        reviewEvery: scaffold.policy.reviewEvery,
      }));
      updateStatus(ctx, goal);
      ctx.ui.notify(`Goal started. State: ${goalPath(goal.id)}`, "info");
      queueContinuation(pi, ctx, goal);
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the current autonomous goal state when explicitly working on an active, blocked, or paused goal. Terminal goals return a short no-active-goal response.",
    promptSnippet: "Read the current active goal objective, lifecycle status, success criteria, evidence, reviews, blockers, progress notes, checklist, and next action.",
    promptGuidelines: [
      "Use get_goal only for explicit goal-related work or autonomous goal continuation turns; do not call it for unrelated repository conversations.",
      "If the response begins with NO_ACTIVE_GOAL, do not treat the terminal goal as current working context unless the user explicitly asks about its history.",
      "When a goal mentions phases, passes, milestones, or numbered steps, treat them as separate autonomous iterations unless the user explicitly says to do them all in one turn.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const goal = await reloadRuntime(ctx);
      if (!goal) return { content: [{ type: "text", text: "NO_ACTIVE_GOAL\nNo goal is currently recorded for this project." }], details: { active: false, found: false } };
      if (isTerminalGoal(goal)) {
        return {
          content: [{ type: "text", text: `NO_ACTIVE_GOAL\nThe last goal is ${goal.status}; no active goal is available.` }],
          details: {
            active: false,
            terminal: true,
            lastGoal: { id: goal.id, status: goal.status, objective: goal.objective, updatedAt: goal.updatedAt },
            path: goalPath(goal.id),
          },
        };
      }
      return {
        content: [{ type: "text", text: renderGoalForModel(goal) }],
        details: { active: goal.status === "active", goal: goalForModel(goal), path: goalPath(goal.id) },
      };
    },
  });

  pi.registerTool({
    name: "goal_inspect_session",
    label: "Goal Inspect Session",
    description: "Inspect a persisted subagent session referenced by the current goal iteration log. Use this for targeted audit/debugging without bloating durable goal state.",
    parameters: Type.Object({
      sessionFile: Type.Optional(Type.String({ description: "Exact sessionFile path from a current goal iteration. Defaults to the most recent referenced session." })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum trailing characters to return; default 12000, capped at 50000." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const goal = await reloadRuntime(ctx);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { found: false } };
      const refs = (goal.iterations ?? []).flatMap((iteration) => iteration.sessionRefs ?? []).filter((ref) => ref.sessionFile);
      const selected = params.sessionFile ? refs.find((ref) => ref.sessionFile === params.sessionFile) : refs.at(-1);
      if (!selected?.sessionFile) {
        return { content: [{ type: "text", text: params.sessionFile ? "Session file is not referenced by the current goal." : "No referenced subagent sessions found." }], details: { found: false } };
      }
      const maxChars = Math.min(Math.max(Math.floor(params.maxChars ?? 12000), 1000), 50000);
      const raw = await readFile(selected.sessionFile, "utf8");
      const text = raw.length > maxChars ? raw.slice(-maxChars) : raw;
      return {
        content: [{ type: "text", text }],
        details: { found: true, sessionRef: selected, truncated: raw.length > maxChars, returnedChars: text.length, totalChars: raw.length },
      };
    },
  });

  pi.registerTool({
    name: "goal_list_scaffolds",
    label: "Goal List Scaffolds",
    description: "List available /goal scaffolds with their merge/review policy. Use before choosing a scaffold for a new or current goal.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const scaffolds = await listScaffolds(ctx.cwd);
      return {
        content: [{ type: "text", text: scaffolds.map((item) => `${item.id} (${item.source}) — ${item.description}\n${scaffoldPolicyText(item)}`).join("\n\n") }],
        details: { scaffolds },
      };
    },
  });

  pi.registerTool({
    name: "goal_get_scaffold",
    label: "Goal Get Scaffold",
    description: "Inspect a /goal scaffold's instructions and merge/review policy.",
    parameters: Type.Object({ id: Type.String({ description: "Scaffold id, such as default, operations, or zenith." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scaffold = await loadScaffold(ctx.cwd, params.id);
      if (scaffold.source === "bundled" && scaffold.id === "default" && params.id !== "default") {
        return { content: [{ type: "text", text: `Scaffold not found: ${params.id}` }], details: { found: false } };
      }
      return {
        content: [{ type: "text", text: `${scaffold.id} (${scaffold.source}) — ${scaffold.description}\n${scaffoldPolicyText(scaffold)}\n\n${scaffold.body}` }],
        details: { found: true, scaffold },
      };
    },
  });

  pi.registerTool({
    name: "goal_set_scaffold",
    label: "Goal Set Scaffold",
    description: "Set the scaffold for the current goal. Use after inspecting/recommending a scaffold or when the user asks for a specific one.",
    parameters: Type.Object({ id: Type.String({ description: "Scaffold id to set on the current goal." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scaffold = await loadScaffold(ctx.cwd, params.id);
      if (scaffold.source === "bundled" && scaffold.id === "default" && params.id !== "default") {
        return { content: [{ type: "text", text: `Scaffold not found: ${params.id}` }], details: { updated: false } };
      }
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, scaffold: params.id, reviewEvery: scaffold.policy.reviewEvery || current.reviewEvery, continuationQueued: false }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: `Goal scaffold set to ${scaffold.id} (${scaffold.source}).` }], details: { updated: true, scaffold, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_recommend_scaffold",
    label: "Goal Recommend Scaffold",
    description: "Recommend an existing scaffold for a proposed objective. This does not start or modify a goal.",
    parameters: Type.Object({ objective: Type.String({ description: "Goal objective to classify." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = recommendScaffoldId(params.objective);
      const scaffold = await loadScaffold(ctx.cwd, id);
      const rationale = id === "operations"
        ? "The objective appears to involve live/external operational state or ongoing automation."
        : id === "zenith"
          ? "The objective appears to involve linear long-horizon gap-closing with evidence and periodic review."
          : "The objective appears bounded enough for the general coherent-progress scaffold.";
      return { content: [{ type: "text", text: `Recommended scaffold: ${scaffold.id}\n${rationale}\n\n${scaffoldPolicyText(scaffold)}` }], details: { scaffold, rationale } };
    },
  });

  pi.registerTool({
    name: "goal_start",
    label: "Goal Start",
    description: "Start a new autonomous goal after explicit user approval. Do not use proactively; first recommend the objective/scaffold and ask the user to approve.",
    parameters: Type.Object({
      objective: Type.String({ description: "Approved goal objective." }),
      approved: Type.Boolean({ description: "Must be true after explicit user approval to start the goal." }),
      scaffold: Type.Optional(Type.String({ description: "Optional scaffold id. Defaults to recommended/default." })),
      maxIterations: Type.Optional(Type.Number({ description: "Optional positive iteration cap." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.approved) {
        return { content: [{ type: "text", text: "goal_start requires explicit user approval. Ask the user to approve the objective/scaffold, then call again with approved=true." }], details: { updated: false, approvalRequired: true } };
      }
      if (!params.objective.trim()) throw new Error("Goal objective is required.");
      if (params.objective.length > MAX_OBJECTIVE_CHARS) throw new Error(`Goal objective is too long (${params.objective.length}/${MAX_OBJECTIVE_CHARS} chars).`);
      const secretError = checkNoSecrets(params.objective, "Goal objective");
      if (secretError) throw new Error(`Refusing to store goal objective: ${secretError}.`);
      const scaffold = await loadScaffold(ctx.cwd, params.scaffold ?? recommendScaffoldId(params.objective));
      const maxIterations = typeof params.maxIterations === "number" && params.maxIterations > 0 ? Math.floor(params.maxIterations) : undefined;
      const goal = await writeGoal(createStoredGoal({
        id: makeId(),
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        objective: params.objective.trim(),
        scaffold: scaffold.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        noteTimestamp: nowIso(),
        noteText: "Goal created via goal_start tool. Do not store secrets in goal notes.",
        maxIterations,
        reviewEvery: scaffold.policy.reviewEvery,
      }));
      updateStatus(ctx, goal);
      queueContinuation(pi, ctx, goal);
      return { content: [{ type: "text", text: `Goal started with scaffold ${scaffold.id}. State: ${goalPath(goal.id)}` }], details: { updated: true, scaffold, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_note",
    label: "Goal Note",
    description: "Update progress notes and structured memory for the current autonomous goal without changing lifecycle fields like status or stepCount.",
    promptSnippet: "Update autonomous goal progress notes, structured facts/assumptions/risks/blockers/evidence, checklist, summary, and next action after meaningful progress.",
    promptGuidelines: [
      "Use goal_note after each meaningful autonomous-goal iteration to record what changed, evidence gathered, and the next hand-off action.",
      "Use structured facts, assumptions, risks, blockers, and evidence fields to keep long-horizon state curated rather than buried in notes.",
      "For multi-phase goals, complete one phase/pass/milestone, call goal_note, then stop so the next autonomous continuation can take the next phase.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Concise current summary of progress." })),
      checklist: Type.Optional(Type.Array(Type.Object({
        text: Type.String({ description: "Checklist item text." }),
        done: Type.Boolean({ description: "Whether this checklist item is complete." }),
        evidence: Type.Optional(Type.String({ description: "Brief evidence, command, file, or result." })),
      }), { description: "Replacement checklist for the goal." })),
      nextAction: Type.Optional(Type.String({ description: "Next concrete action for the following iteration." })),
      note: Type.Optional(Type.String({ description: "Append a concise progress note." })),
      facts: Type.Optional(Type.Array(Type.String(), { description: "Replacement durable facts list." })),
      assumptions: Type.Optional(Type.Array(Type.String(), { description: "Replacement assumptions list." })),
      risks: Type.Optional(Type.Array(Type.String(), { description: "Replacement risks list." })),
      blockers: Type.Optional(Type.Array(Type.String(), { description: "Replacement blockers list." })),
      evidence: Type.Optional(Type.Array(Type.String(), { description: "Replacement evidence list." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = checkNoSecrets(params.summary, "summary")
        ?? checkNoSecrets(params.nextAction, "nextAction")
        ?? checkNoSecrets(params.note, "note")
        ?? params.checklist?.map((item) => checkNoSecrets(item.text, "checklist text") ?? checkNoSecrets(item.evidence, "checklist evidence")).find(Boolean)
        ?? params.facts?.map((item) => checkNoSecrets(item, "facts")).find(Boolean)
        ?? params.assumptions?.map((item) => checkNoSecrets(item, "assumptions")).find(Boolean)
        ?? params.risks?.map((item) => checkNoSecrets(item, "risks")).find(Boolean)
        ?? params.blockers?.map((item) => checkNoSecrets(item, "blockers")).find(Boolean)
        ?? params.evidence?.map((item) => checkNoSecrets(item, "evidence")).find(Boolean);
      if (secretError) throw new Error(`Refusing to store goal note: ${secretError}.`);

      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        summary: params.summary ?? current.summary,
        checklist: params.checklist ?? current.checklist,
        nextAction: params.nextAction ?? current.nextAction,
        facts: params.facts ?? current.facts,
        assumptions: params.assumptions ?? current.assumptions,
        risks: params.risks ?? current.risks,
        blockers: params.blockers ?? current.blockers,
        evidence: params.evidence ?? current.evidence,
        notes: params.note ? [...current.notes, { timestamp: nowIso(), text: params.note }].slice(-50) : current.notes,
      }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal notes updated." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_phases",
    label: "Goal Phases",
    description: "Create or replace ordered phase gates for the current goal. Only the current phase is actionable; the orchestrator advances phases after reviewer verification.",
    promptSnippet: "Define ordered, evidence-gated phases for a long-running goal.",
    parameters: Type.Object({
      phases: Type.Array(Type.Object({
        id: Type.String(),
        title: Type.String(),
        objective: Type.String(),
        status: Type.Optional(StringEnum(["pending", "active", "passed", "blocked"] as const)),
        criterionIds: Type.Optional(Type.Array(Type.String())),
        scaffold: Type.Optional(Type.String()),
        nextAction: Type.Optional(Type.String()),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = params.phases.map((phase) => [phase.id, phase.title, phase.objective, phase.scaffold, phase.nextAction].map((item) => checkNoSecrets(item, "phase")).find(Boolean)).find(Boolean);
      if (secretError) throw new Error(`Refusing to store goal phases: ${secretError}.`);
      const normalizedPhases = normalizePhases(params.phases);
      const ids = new Set();
      for (const phase of normalizedPhases) {
        if (ids.has(phase.id)) throw new Error(`Duplicate phase id: ${phase.id}`);
        ids.add(phase.id);
      }
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => {
        const criterionIds = new Set((current.criteria ?? []).map((criterion) => criterion.id));
        const unknown = normalizedPhases.flatMap((phase) => phase.criterionIds).find((id) => !criterionIds.has(id));
        if (unknown) throw new Error(`Phase references unknown criterion: ${unknown}`);
        const firstOpen = normalizedPhases.find((phase) => phase.status !== "passed");
        const phases = normalizedPhases.map((phase) => phase.id === (firstOpen?.id ?? phase.id) && phase.status === "pending" ? { ...phase, status: "active" } : phase);
        return {
          ...current,
          phases,
          currentPhaseId: phases.find((phase) => phase.status === "active")?.id ?? phases[0]?.id,
          notes: [...current.notes, { timestamp: nowIso(), text: `Goal phases replaced (${phases.length} phase${phases.length === 1 ? "" : "s"}).` }].slice(-50),
        };
      });
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal phases updated." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_criteria",
    label: "Goal Criteria",
    description: "Create or replace evidence-bearing success criteria for the current goal.",
    promptSnippet: "Define falsifiable success criteria for complex or long-horizon goals.",
    parameters: Type.Object({
      criteria: Type.Array(Type.Object({
        id: Type.Optional(Type.String()),
        text: Type.String(),
        status: Type.Optional(StringEnum(["pending", "passed", "failed"] as const)),
        evidence: Type.Optional(Type.String()),
        phaseId: Type.Optional(Type.String()),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = params.criteria.map((item) => checkNoSecrets(item.id, "criterion id") ?? checkNoSecrets(item.text, "criterion text") ?? checkNoSecrets(item.evidence, "criterion evidence") ?? checkNoSecrets(item.phaseId, "criterion phase id")).find(Boolean);
      if (secretError) throw new Error(`Refusing to store goal criteria: ${secretError}.`);
      const normalizedCriteria = normalizeCriteriaInputs(params.criteria);
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        criteria: normalizedCriteria,
        notes: [...current.notes, { timestamp: nowIso(), text: `Success criteria replaced (${normalizedCriteria.length} item${normalizedCriteria.length === 1 ? "" : "s"}).` }].slice(-50),
      }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal criteria updated." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_criterion_update",
    label: "Goal Criterion Update",
    description: "Update status and evidence for existing goal success criteria.",
    promptSnippet: "Mark success criteria pending, failed, or passed with concrete evidence.",
    parameters: Type.Object({
      updates: Type.Array(Type.Object({
        id: Type.String(),
        status: StringEnum(["pending", "passed", "failed"] as const),
        evidence: Type.Optional(Type.String()),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = params.updates.map((item) => checkNoSecrets(item.id, "criterion id") ?? checkNoSecrets(item.evidence, "criterion evidence")).find(Boolean);
      if (secretError) throw new Error(`Refusing to store criterion update: ${secretError}.`);
      let updatedCriteria: GoalCriterion[] = [];
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => {
        updatedCriteria = applyCriterionUpdates(current.criteria ?? [], params.updates) as GoalCriterion[];
        return {
          ...current,
          criteria: updatedCriteria,
          notes: [...current.notes, { timestamp: nowIso(), text: `Criteria updated: ${params.updates.map((item) => `${item.id}=${item.status}`).join(", ")}.` }].slice(-50),
        };
      });
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal criteria status updated." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_review",
    label: "Goal Review",
    description: "Record a terminal-readiness or strategic review for the current goal.",
    promptSnippet: "Review goal alignment, evidence, gaps, and readiness before completion.",
    parameters: Type.Object({
      verdict: StringEnum(["ready_to_complete", "not_ready", "blocked"] as const),
      findings: Type.Array(Type.String()),
      unresolvedGaps: Type.Optional(Type.Array(Type.String())),
      evidenceSummary: Type.String(),
      evidence: Type.Optional(Type.Array(Type.Object({
        kind: StringEnum(["command", "file", "test", "url", "session", "observation", "artifact"] as const),
        ref: Type.String(),
        status: Type.Optional(StringEnum(["passed", "failed", "observed", "created", "modified", "not_run"] as const)),
        summary: Type.String(),
      }))),
      phaseTransition: Type.Optional(Type.Object({
        toPhaseId: Type.String(),
        evidence: Type.Optional(Type.Array(Type.Object({
          kind: StringEnum(["command", "file", "test", "url", "session", "observation", "artifact"] as const),
          ref: Type.String(),
          status: Type.Optional(StringEnum(["passed", "failed", "observed", "created", "modified", "not_run"] as const)),
          summary: Type.String(),
        }))),
      })),
      criteriaAssessment: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        status: StringEnum(["proven", "not_proven", "contradicted", "missing_evidence"] as const),
        reason: Type.String(),
        evidence: Type.Optional(Type.Array(Type.Object({
          kind: StringEnum(["command", "file", "test", "url", "session", "observation", "artifact"] as const),
          ref: Type.String(),
          status: Type.Optional(StringEnum(["passed", "failed", "observed", "created", "modified", "not_run"] as const)),
          summary: Type.String(),
        }))),
      }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const report = {
        schemaVersion: 1 as const,
        role: "reviewer" as const,
        outcome: "review_complete" as const,
        summary: params.evidenceSummary,
        confidence: "high" as const,
        actions: [],
        evidence: params.evidence ?? [],
        verdict: params.verdict,
        findings: params.findings,
        unresolvedGaps: params.unresolvedGaps,
        criteriaAssessment: params.criteriaAssessment ?? [],
        phaseTransition: params.phaseTransition,
      };
      validateGoalAgentReport(report);
      const secretError = checkReportForSecrets(report);
      if (secretError) throw new Error(`Refusing to store goal review: ${secretError}.`);
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => {
        const reviewed = applyGoalReviewerReport(current, report, { now: nowIso(), reviewKind: params.phaseTransition ? "phase_gate" : "terminal" }) as StoredGoal;
        return {
          ...reviewed,
          // Manual review records readiness; update_goal remains the explicit completion command.
          status: params.verdict === "blocked" ? "blocked" : current.status,
          stopReason: params.verdict === "blocked" ? "blocked" : current.stopReason,
          continuationQueued: params.verdict === "blocked" ? false : current.continuationQueued,
        };
      });
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal review recorded." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "goal_block",
    label: "Goal Block",
    description: "Mark the current goal blocked with a concrete reason and needed user/runtime action.",
    promptSnippet: "Use when missing information or unsafe conditions prevent productive continuation.",
    parameters: Type.Object({
      reason: Type.String(),
      neededFromUser: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = checkNoSecrets(params.reason, "block reason") ?? checkNoSecrets(params.neededFromUser, "neededFromUser") ?? checkNoSecrets(params.evidence, "block evidence");
      if (secretError) throw new Error(`Refusing to store goal blocker: ${secretError}.`);
      const nextAction = params.neededFromUser ?? "User/runtime input is needed to unblock the goal.";
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        status: "blocked",
        stopReason: "blocked",
        nextAction,
        blockers: [...(current.blockers ?? []), params.reason],
        evidence: params.evidence ? [...(current.evidence ?? []), params.evidence] : current.evidence,
        notes: [...current.notes, { timestamp: nowIso(), text: `Goal blocked: ${params.reason}` }].slice(-50),
        continuationQueued: false,
      }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal marked blocked. Autonomous continuation will stop until /goal resume." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the active autonomous goal complete after success criteria and terminal review prove readiness. The model may only set status to complete; pause/resume/clear are user-controlled.",
    promptSnippet: "Mark the active autonomous goal complete only after all criteria are passed with evidence and goal_review records ready_to_complete.",
    promptGuidelines: [
      "Do not use update_goal until all requested phases, passes, milestones, or success criteria are complete and verified with concrete evidence.",
      "Before update_goal, use goal_review with verdict ready_to_complete and ensure every success criterion is passed with evidence.",
      "If any next phase, unresolved gap, blocker, or stretch goal remains, use goal_note, goal_review, or goal_block instead of update_goal and leave a clear next action.",
    ],
    parameters: Type.Object({
      status: StringEnum(["complete"] as const, { description: "Only 'complete' is accepted." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete") throw new Error("update_goal only accepts status='complete'.");
      const current = await readCurrentGoal(ctx.cwd);
      if (!current) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      const readiness = completionReadiness(current);
      if (!readiness.ready) {
        return { content: [{ type: "text", text: `Goal is not ready to complete:\n${readiness.missing.map((item: string) => `- ${item}`).join("\n")}` }], details: { updated: false, missing: readiness.missing, goal: goalForModel(current), path: goalPath(current.id) } };
      }
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        status: "complete",
        continuationQueued: false,
      }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal marked complete. Autonomous continuation will stop." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    const goal = await reloadRuntime(ctx);
    if (goal?.status === "active") {
      ctx.ui.notify(`Active goal loaded from ${basename(goalPath(goal.id))}. Use /goal pause to stop autonomous continuation.`, "info");
      queueContinuation(pi, ctx, goal);
    }
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (runtime) runtime.continuationQueued = false;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const goal = await readCurrentGoal(ctx.cwd);
    runtime = goal;
    updateStatus(ctx, goal);
    if (goal?.status === "active") queueContinuation(pi, ctx, goal);
  });
}
