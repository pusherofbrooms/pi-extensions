import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { detectSecret } from "./guardrails-core.mjs";
import { applyCriterionUpdates, completionReadiness, normalizeCriteriaInputs, normalizeGoal, validateReview } from "./goal-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MAX_OBJECTIVE_CHARS = 4000;
const STORE_DIR = join(homedir(), ".pi", "agent", "goals");
const GOALS_DIR = join(STORE_DIR, "goals");
const INDEX_PATH = join(STORE_DIR, "index.json");

type GoalStatus = "active" | "paused" | "blocked" | "complete" | "cleared";

type GoalCriterionStatus = "pending" | "passed" | "failed";

type GoalCriterion = {
  id: string;
  text: string;
  status: GoalCriterionStatus;
  evidence?: string;
};

type GoalReviewVerdict = "ready_to_complete" | "not_ready" | "blocked";

type GoalReview = {
  timestamp: string;
  verdict: GoalReviewVerdict;
  findings: string[];
  unresolvedGaps?: string[];
  evidenceSummary: string;
};

type GoalChecklistItem = {
  text: string;
  done: boolean;
  evidence?: string;
};

type GoalNoteEntry = {
  timestamp: string;
  text: string;
};

type StoredGoal = {
  version: 1;
  id: string;
  cwd: string;
  sessionFile?: string;
  status: GoalStatus;
  objective: string;
  scaffold?: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  maxIterations?: number;
  stopReason?: string;
  summary: string;
  checklist: GoalChecklistItem[];
  criteria?: GoalCriterion[];
  reviews?: GoalReview[];
  facts?: string[];
  assumptions?: string[];
  risks?: string[];
  blockers?: string[];
  evidence?: string[];
  reviewEvery?: number;
  lastReviewStep?: number;
  nextAction: string;
  notes: GoalNoteEntry[];
  continuationQueued?: boolean;
  lastContinuationAt?: number;
};

type GoalIndex = {
  version: 1;
  byCwd: Record<string, string>;
};

let runtime: StoredGoal | undefined;
let activeGoalTurn: { id: string; startStep: number } | undefined;
let shuttingDown = false;

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureStore();
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  const current = await readCurrentGoal(cwd);
  if (!current) return undefined;
  return writeGoal(mutator(current));
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

  return `${goalSummary(goal)}\n\nSuccess criteria:\n${criteria}\n\n${structured}\n\nChecklist:\n${checklist}\n\nLatest review:\n${reviewText}\n\nRecent notes:\n${notes}`;
}

function updateStatus(ctx: ExtensionContext, goal?: StoredGoal): void {
  if (!goal || goal.status === "complete" || goal.status === "cleared") {
    ctx.ui.setStatus("goal", "");
    return;
  }
  const cap = goal.maxIterations ? `/${goal.maxIterations}` : "";
  ctx.ui.setStatus("goal", `goal: ${goal.status} ${goal.stepCount}${cap}`);
}

function continuationPrompt(goal: StoredGoal): string {
  const needsReview = !!goal.reviewEvery && goal.stepCount > 0 && goal.stepCount % goal.reviewEvery === 0 && goal.lastReviewStep !== goal.stepCount;
  return `${needsReview ? "Perform a strategic review of" : "Continue working toward"} the active goal.\n\nUse get_goal first to inspect objective, progress, criteria, evidence, checklist, and next action. Use goal_note after meaningful progress to update summary/checklist/next action/notes. Do not edit goal lifecycle state manually; the extension owns status, timestamps, stepCount, and maxIterations.\n\nGoal:\n<objective>\n${goal.objective}\n</objective>\n\nStep: ${goal.stepCount}${goal.maxIterations ? ` / ${goal.maxIterations}` : ""}\n\nIteration policy:\n- Complete one coherent unit of progress in this turn, then update goal state with the next action and stop.\n- A coherent unit may be a single focused change, a bounded investigation, a review, or an operating cycle that checks several live concerns and advances one primary concern.\n- If the objective describes phases, passes, milestones, or numbered steps, do not rush ahead into later phases just because they are easy. Leave clear hand-off notes for the next continuation.\n\nBefore acting, compare the current goal state against the original objective and success criteria. Identify the important open concerns, choose a bounded coherent unit for this turn, and avoid repeating work that is already done.\n\nIf this is a complex or long-horizon goal and no success criteria exist, use goal_criteria before substantial execution.\n\n${needsReview ? "This is a scheduled strategic review iteration. Do not do broad new execution. Review alignment, stale assumptions, evidence quality, blockers, repeated ineffective actions, and the highest-value next operating focus; then call goal_review and/or goal_note.\n\n" : ""}Before deciding the goal is complete, audit the current state against the objective:\n- Identify the concrete deliverables/success criteria.\n- Verify relevant files, command outputs, tests, docs, or other evidence.\n- Treat uncertainty as not complete.\n\nOnly call update_goal with status "complete" after every required phase/pass/milestone is complete, all success criteria are passed with evidence, and goal_review records ready_to_complete. Otherwise call goal_note, goal_review, goal_criterion_update, or goal_block with concise progress, evidence, and next action, then end your response.`;
}

function queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): void {
  if (shuttingDown || goal.status !== "active" || goal.continuationQueued) return;
  if (ctx.hasPendingMessages()) return;

  goal.continuationQueued = true;
  goal.lastContinuationAt = Date.now();
  runtime = goal;
  updateStatus(ctx, goal);

  setTimeout(() => {
    try {
      pi.sendUserMessage(continuationPrompt(goal), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    } catch (error) {
      goal.continuationQueued = false;
      runtime = goal;
      ctx.ui.notify(`Failed to queue goal continuation: ${(error as Error).message}`, "error");
    }
  }, 0);
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

Model tools for long-horizon goals:
get_goal, goal_note, goal_criteria, goal_criterion_update, goal_review, goal_block, update_goal.`;
}

export default function goalExtension(pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Set, inspect, pause, resume, clear, or complete a tool-backed autonomous goal.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
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

      const goal = await writeGoal({
        version: 1,
        id: makeId(),
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        status: "active",
        objective,
        scaffold: "default",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        stepCount: 0,
        maxIterations,
        summary: "Goal created. No progress yet.",
        checklist: [],
        criteria: [],
        reviews: [],
        facts: [],
        assumptions: [],
        risks: [],
        blockers: [],
        evidence: [],
        nextAction: "Inspect the goal and choose the first concrete action.",
        notes: [{ timestamp: nowIso(), text: "Goal created. Do not store secrets in goal notes." }],
        continuationQueued: false,
      });
      updateStatus(ctx, goal);
      ctx.ui.notify(`Goal started. State: ${goalPath(goal.id)}`, "info");
      queueContinuation(pi, ctx, goal);
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the current autonomous goal state, including criteria, evidence, reviews, blockers, and notes. Always use this first when continuing goal work.",
    promptSnippet: "Read the current autonomous goal objective, lifecycle status, success criteria, evidence, reviews, blockers, progress notes, checklist, and next action.",
    promptGuidelines: [
      "Use get_goal first on autonomous goal continuation turns before choosing work.",
      "When a goal mentions phases, passes, milestones, or numbered steps, treat them as separate autonomous iterations unless the user explicitly says to do them all in one turn.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const goal = await reloadRuntime(ctx);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { active: false } };
      return {
        content: [{ type: "text", text: renderGoalForModel(goal) }],
        details: { active: goal.status === "active", goal: goalForModel(goal), path: goalPath(goal.id) },
      };
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
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = params.criteria.map((item) => checkNoSecrets(item.id, "criterion id") ?? checkNoSecrets(item.text, "criterion text") ?? checkNoSecrets(item.evidence, "criterion evidence")).find(Boolean);
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      validateReview(params);
      const allText = [params.evidenceSummary, ...params.findings, ...(params.unresolvedGaps ?? [])];
      const secretError = allText.map((item) => checkNoSecrets(item, "review text")).find(Boolean);
      if (secretError) throw new Error(`Refusing to store goal review: ${secretError}.`);
      const review: GoalReview = { timestamp: nowIso(), verdict: params.verdict, findings: params.findings, unresolvedGaps: params.unresolvedGaps, evidenceSummary: params.evidenceSummary };
      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        status: params.verdict === "blocked" ? "blocked" : current.status,
        stopReason: params.verdict === "blocked" ? "blocked" : current.stopReason,
        reviews: [...(current.reviews ?? []), review].slice(-20),
        lastReviewStep: current.stepCount,
        nextAction: params.verdict === "ready_to_complete" ? "Complete the goal if all criteria are passed." : params.unresolvedGaps?.[0] ?? current.nextAction,
        continuationQueued: params.verdict === "blocked" ? false : current.continuationQueued,
      }));
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
        stepCount: activeGoalTurn?.id === current.id ? activeGoalTurn.startStep + 1 : current.stepCount,
        continuationQueued: false,
      }));
      activeGoalTurn = undefined;
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

  pi.on("agent_start", async () => {
    if (runtime?.continuationQueued) activeGoalTurn = { id: runtime.id, startStep: runtime.stepCount };
    if (runtime) runtime.continuationQueued = false;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const goal = await readCurrentGoal(ctx.cwd);
    const countedTurn = activeGoalTurn;
    const shouldCountStep = !!goal && countedTurn?.id === goal.id;
    activeGoalTurn = undefined;

    if (!goal || goal.status !== "active") {
      runtime = goal;
      updateStatus(ctx, goal);
      return;
    }

    if (!shouldCountStep) {
      runtime = goal;
      updateStatus(ctx, goal);
      queueContinuation(pi, ctx, goal);
      return;
    }

    const nextStep = countedTurn.startStep + 1;
    const reachedCap = goal.maxIterations !== undefined && nextStep >= goal.maxIterations;
    const updated = await writeGoal({
      ...goal,
      stepCount: nextStep,
      status: reachedCap ? "paused" : "active",
      stopReason: reachedCap ? "maxIterationsReached" : goal.stopReason,
      continuationQueued: false,
    });
    updateStatus(ctx, updated);

    if (reachedCap) {
      ctx.ui.notify(`Goal paused after reaching max iterations (${goal.maxIterations}).`, "warning");
      return;
    }

    queueContinuation(pi, ctx, updated);
  });
}
