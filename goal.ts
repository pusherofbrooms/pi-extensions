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
import type { GoalIndex, GoalRuntimeDeps, GoalScaffold, StoredGoal } from "./goal-types.ts";
import { registerGoalCommand } from "./goal-command.ts";
import { buildGoalContextPacket, completionReadiness, isTerminalGoal, normalizeGoal, validateGoalAgentReport } from "./goal-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonRetryableContinuationError } from "./goal-reports.ts";
import { registerGoalTools } from "./goal-tools.ts";
import { runGoalObserver, runGoalResearcher, runGoalWorker, runParentReview, runScheduledStrategicReview } from "./goal-agents.ts";
import { queueContinuation as scheduleContinuation, runDelegatedContinuation as continueDelegatedGoal, type GoalContinuationServices } from "./goal-continuation.ts";
export { NonRetryableReportError, isNonRetryableContinuationError } from "./goal-reports.ts";
export { delegatedPrompt, observerPrompt, researcherPrompt, strategicReviewPrompt, parentReviewPrompt, parseOrRepairGoalAgentReport, runIsolatedAgent, runGoalObserver, runGoalResearcher, runGoalWorker, runScheduledStrategicReview, runParentReview } from "./goal-agents.ts";

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


function checkNoSecrets(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const match = detectSecret(value);
  return match ? `${label} contains a possible secret (${match})` : undefined;
}

const continuationServices: GoalContinuationServices = {
  loadScaffold,
  runScheduledStrategicReview,
  runGoalObserver,
  runGoalResearcher,
  runGoalWorker,
  runParentReview,
  updateStatus,
  goalForModel,
  goalPath,
  queueContinuation,
  checkNoSecrets,
};

export function runDelegatedContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal, deps: GoalRuntimeDeps = DEFAULT_GOAL_RUNTIME_DEPS): Promise<void> {
  return continueDelegatedGoal(pi, ctx, goal, deps, continuationServices);
}

function queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): void {
  scheduleContinuation(pi, ctx, goal, {
    isShuttingDown: () => shuttingDown,
    getRuntime: () => runtime,
    setRuntime: (next) => { runtime = next; },
    updateStatus,
    readCurrentGoal,
    runDelegatedContinuation,
    isNonRetryableContinuationError,
    nowMs: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
  });
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
