import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { detectSecret } from "./guardrails-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MAX_OBJECTIVE_CHARS = 4000;
const STORE_DIR = join(homedir(), ".pi", "agent", "goals");
const GOALS_DIR = join(STORE_DIR, "goals");
const INDEX_PATH = join(STORE_DIR, "index.json");

type GoalStatus = "active" | "paused" | "complete" | "cleared";

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
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  maxIterations?: number;
  stopReason?: string;
  summary: string;
  checklist: GoalChecklistItem[];
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
  return readJson<StoredGoal>(goalPath(id));
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
  const checklist = goal.checklist.length
    ? goal.checklist.map((item) => `- [${item.done ? "x" : " "}] ${item.text}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n")
    : "- [ ] No checklist items recorded yet.";
  const notes = goal.notes.length
    ? goal.notes.slice(-8).map((note) => `- ${note.timestamp}: ${note.text}`).join("\n")
    : "- No notes recorded yet.";

  return `${goalSummary(goal)}\n\nChecklist:\n${checklist}\n\nRecent notes:\n${notes}`;
}

function updateStatus(ctx: ExtensionContext, goal?: StoredGoal): void {
  if (!goal || goal.status === "cleared") {
    ctx.ui.setStatus("goal", "");
    return;
  }
  const cap = goal.maxIterations ? `/${goal.maxIterations}` : "";
  ctx.ui.setStatus("goal", `goal: ${goal.status} ${goal.stepCount}${cap}`);
}

function continuationPrompt(goal: StoredGoal): string {
  return `Continue working toward the active goal.\n\nUse get_goal first to inspect objective, progress, checklist, and next action. Use goal_note after meaningful progress to update summary/checklist/next action/notes. Do not edit goal lifecycle state manually; the extension owns status, timestamps, stepCount, and maxIterations.\n\nGoal:\n<objective>\n${goal.objective}\n</objective>\n\nStep: ${goal.stepCount}${goal.maxIterations ? ` / ${goal.maxIterations}` : ""}\n\nIteration policy:\n- If the objective describes phases, passes, milestones, or numbered steps, treat each as a separate autonomous iteration unless the goal explicitly says otherwise.\n- Complete exactly one meaningful iteration in this turn, then call goal_note with the next action and stop.\n- Do not rush ahead into later phases just because they are easy. Leave clear hand-off notes for the next continuation.\n\nChoose the next concrete action toward the goal. Avoid repeating work that is already done.\n\nBefore deciding the goal is complete, audit the current state against the objective:\n- Identify the concrete deliverables/success criteria.\n- Verify relevant files, command outputs, tests, docs, or other evidence.\n- Treat uncertainty as not complete.\n\nOnly call update_goal with status "complete" after every required phase/pass/milestone is complete and verified. Otherwise call goal_note with concise progress, evidence, and next action, then end your response.`;
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

      if (subcommand === "pause" || subcommand === "complete" || subcommand === "clear") {
        const status = subcommand as GoalStatus;
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
        createdAt: nowIso(),
        updatedAt: nowIso(),
        stepCount: 0,
        maxIterations,
        summary: "Goal created. No progress yet.",
        checklist: [],
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
    description: "Read the current autonomous goal state. Always use this first when continuing goal work.",
    promptSnippet: "Read the current autonomous goal objective, lifecycle status, progress notes, checklist, and next action.",
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
    description: "Update progress notes for the current autonomous goal without changing lifecycle fields like status or stepCount.",
    promptSnippet: "Update autonomous goal progress notes, checklist, summary, and next action after meaningful progress.",
    promptGuidelines: [
      "Use goal_note after each meaningful autonomous-goal iteration to record what changed, evidence gathered, and the next hand-off action.",
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const secretError = checkNoSecrets(params.summary, "summary")
        ?? checkNoSecrets(params.nextAction, "nextAction")
        ?? checkNoSecrets(params.note, "note")
        ?? params.checklist?.map((item) => checkNoSecrets(item.text, "checklist text") ?? checkNoSecrets(item.evidence, "checklist evidence")).find(Boolean);
      if (secretError) throw new Error(`Refusing to store goal note: ${secretError}.`);

      const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({
        ...current,
        summary: params.summary ?? current.summary,
        checklist: params.checklist ?? current.checklist,
        nextAction: params.nextAction ?? current.nextAction,
        notes: params.note ? [...current.notes, { timestamp: nowIso(), text: params.note }].slice(-50) : current.notes,
      }));
      updateStatus(ctx, goal);
      if (!goal) return { content: [{ type: "text", text: "No current goal found." }], details: { updated: false } };
      return { content: [{ type: "text", text: "Goal notes updated." }], details: { updated: true, goal: goalForModel(goal), path: goalPath(goal.id) } };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the active autonomous goal complete. The model may only set status to complete; pause/resume/clear are user-controlled.",
    promptSnippet: "Mark the active autonomous goal complete when it is fully verified.",
    promptGuidelines: [
      "Do not use update_goal until all requested phases, passes, milestones, or success criteria are complete and verified with concrete evidence.",
      "If any next phase or stretch goal remains, use goal_note instead of update_goal and leave a clear next action.",
    ],
    parameters: Type.Object({
      status: StringEnum(["complete"] as const, { description: "Only 'complete' is accepted." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete") throw new Error("update_goal only accepts status='complete'.");
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
