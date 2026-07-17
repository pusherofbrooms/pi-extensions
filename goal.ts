import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runAgentSession } from "./agent-runner.ts";
import { detectSecret } from "./secret-detection.mjs";
import { atomicWriteJson, withPersistenceLock } from "./goal-persistence.mjs";
import { listScaffolds as listScaffoldsFromDirectories, loadScaffold as loadScaffoldFromDirectories, parseFrontmatter } from "./goal-scaffolds.ts";
import type { GoalAgentReport, GoalIndex, GoalIteration, GoalRoleCheckpoint, GoalRuntimeDeps, GoalScaffold, GoalSubagentRole, GoalSubagentSessionRef, StoredGoal } from "./goal-types.ts";
import { registerGoalCommand } from "./goal-command.ts";
import { appendGoalRoleCheckpoint, applyGoalReviewerReport, buildGoalContextPacket, completionReadiness, currentGoalPhase, isTerminalGoal, nextGoalPhase, normalizeGoal, selectGoalWorkflowPlan, validateGoalAgentReport } from "./goal-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDelegatedReport, evidenceText, isNonRetryableContinuationError } from "./goal-reports.ts";
import { registerGoalTools } from "./goal-tools.ts";
import { runGoalObserver, runGoalResearcher, runGoalWorker, runParentReview, runScheduledStrategicReview } from "./goal-agents.ts";
export { NonRetryableReportError, isNonRetryableContinuationError } from "./goal-reports.ts";
export { delegatedPrompt, observerPrompt, researcherPrompt, strategicReviewPrompt, parentReviewPrompt, parseOrRepairGoalAgentReport, runIsolatedAgent, runGoalObserver, runGoalResearcher, runGoalWorker, runScheduledStrategicReview, runParentReview } from "./goal-agents.ts";

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

export default function goalExtension(pi: ExtensionAPI) {
  registerGoalCommand(pi, {
    checkNoSecrets,
    goalPath,
    goalSummary,
    listScaffolds,
    loadScaffold,
    makeId,
    mutateCurrentGoal,
    now: nowIso,
    queueContinuation,
    reloadRuntime,
    updateStatus,
    writeGoal,
  });

  registerGoalTools(pi, {
    checkNoSecrets,
    goalForModel,
    goalPath,
    listScaffolds,
    loadScaffold,
    makeId,
    mutateCurrentGoal,
    now: nowIso,
    queueContinuation,
    readCurrentGoal,
    readSessionFile: (path) => readFile(path, "utf8"),
    reloadRuntime,
    renderGoalForModel,
    updateStatus,
    writeGoal,
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
