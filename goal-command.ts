import {
  type ExtensionAPI,
  type ExtensionContext,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { createStoredGoal } from "./goal-factory.ts";
import { scaffoldPolicyText } from "./goal-scaffolds.ts";
import type { GoalScaffold, GoalStatus, StoredGoal } from "./goal-types.ts";

const MAX_OBJECTIVE_CHARS = 4000;

export interface GoalCommandServices {
  checkNoSecrets(value: string | undefined, label: string): string | undefined;
  goalPath(id: string): string;
  goalSummary(goal: StoredGoal): string;
  listScaffolds(cwd: string): Promise<GoalScaffold[]>;
  loadScaffold(cwd: string, id?: string): Promise<GoalScaffold>;
  makeId(): string;
  mutateCurrentGoal(cwd: string, mutator: (goal: StoredGoal) => StoredGoal): Promise<StoredGoal | undefined>;
  now(): string;
  queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): void;
  reloadRuntime(ctx: ExtensionContext): Promise<StoredGoal | undefined>;
  updateStatus(ctx: ExtensionContext, goal?: StoredGoal): void;
  writeGoal(goal: StoredGoal): Promise<StoredGoal>;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCreateArgs(args: string): { objective: string; maxIterations?: number } {
  const trimmed = args.trim();
  const match = trimmed.match(/^--max\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return { objective: trimmed };
  return { maxIterations: parsePositiveInt(match[1]), objective: match[2].trim() };
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

export function registerGoalCommand(pi: ExtensionAPI, services: GoalCommandServices): void {
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
      if (!services.checkNoSecrets(commandText, "Goal command")) pi.appendEntry("goal-command", { text: commandText });
      const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase();

      if (!trimmed || subcommand === "status") {
        const goal = await services.reloadRuntime(ctx);
        ctx.ui.notify(goal ? services.goalSummary(goal) : "No current goal found.", goal ? "info" : "warning");
        return;
      }
      if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        ctx.ui.notify(goalHelp(), "info");
        return;
      }
      if (subcommand === "scaffolds") {
        const scaffolds = await services.listScaffolds(ctx.cwd);
        ctx.ui.notify(scaffolds.map((item) => `${item.id} (${item.source}) — ${item.description}\n  ${scaffoldPolicyText(item).replace(/\n/g, "\n  ")}`).join("\n"), "info");
        return;
      }
      if (subcommand === "scaffold") {
        const value = trimmed.slice("scaffold".length).trim();
        const current = await services.reloadRuntime(ctx);
        if (!current) {
          ctx.ui.notify("No current goal found.", "warning");
          return;
        }
        if (!value || value === "status") {
          const scaffold = await services.loadScaffold(ctx.cwd, current.scaffold ?? "default");
          ctx.ui.notify(`Current scaffold: ${scaffold.id} (${scaffold.source})\n${scaffold.description}\n${scaffoldPolicyText(scaffold)}`, "info");
          return;
        }
        const scaffold = await services.loadScaffold(ctx.cwd, value);
        if (scaffold.source === "bundled" && scaffold.id === "default" && value !== "default") {
          ctx.ui.notify(`Scaffold not found: ${value}`, "warning");
          return;
        }
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, scaffold: value, continuationQueued: false }));
        services.updateStatus(ctx, goal);
        ctx.ui.notify(`Goal scaffold set to ${scaffold.id} (${scaffold.source}).`, "info");
        return;
      }
      if (subcommand === "pause" || subcommand === "complete" || subcommand === "clear") {
        const status = (subcommand === "clear" ? "cleared" : subcommand === "pause" ? "paused" : subcommand) as GoalStatus;
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => ({
          ...current,
          status,
          stopReason: status === "cleared" ? "clearedByUser" : status === "paused" ? "pausedByUser" : current.stopReason,
          continuationQueued: false,
        }));
        services.updateStatus(ctx, goal);
        ctx.ui.notify(goal ? `Goal marked ${status}.` : "No current goal found.", goal ? "info" : "warning");
        return;
      }
      if (subcommand === "resume") {
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, status: "active", stopReason: undefined, continuationQueued: false }));
        if (!goal) {
          ctx.ui.notify("No current goal found to resume.", "warning");
          return;
        }
        services.updateStatus(ctx, goal);
        ctx.ui.notify("Goal resumed; queuing continuation.", "info");
        services.queueContinuation(pi, ctx, goal);
        return;
      }
      if (subcommand === "more" || subcommand === "--more") {
        const additionalIterations = parsePositiveInt(trimmed.slice(subcommand.length).trim());
        if (!additionalIterations) {
          ctx.ui.notify("Usage: /goal more <positive-number>", "warning");
          return;
        }
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => extendMaxIterations(current, additionalIterations));
        services.updateStatus(ctx, goal);
        if (!goal) {
          ctx.ui.notify("No current goal found.", "warning");
          return;
        }
        ctx.ui.notify(`Goal max iterations extended to ${goal.maxIterations}.`, "info");
        if (goal.status === "active") services.queueContinuation(pi, ctx, goal);
        return;
      }
      if (subcommand === "max") {
        const value = trimmed.slice(3).trim().toLowerCase();
        const maxIterations = value === "none" ? undefined : parsePositiveInt(value);
        if (value !== "none" && !maxIterations) {
          ctx.ui.notify("Usage: /goal max <positive-number|none>", "warning");
          return;
        }
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, maxIterations, continuationQueued: false }));
        services.updateStatus(ctx, goal);
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
        const goal = await services.mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, reviewEvery, continuationQueued: false }));
        services.updateStatus(ctx, goal);
        ctx.ui.notify(goal ? `Goal review interval ${reviewEvery ?? "cleared"}.` : "No current goal found.", goal ? "info" : "warning");
        return;
      }

      const { objective, maxIterations } = parseCreateArgs(trimmed);
      if (subcommand === "--max" && !maxIterations) {
        ctx.ui.notify("Usage: /goal --max <positive-number> <objective>", "warning");
        return;
      }
      if (!objective) {
        ctx.ui.notify("Usage: /goal <objective>", "warning");
        return;
      }
      if (objective.length > MAX_OBJECTIVE_CHARS) {
        ctx.ui.notify(`Goal objective is too long (${objective.length}/${MAX_OBJECTIVE_CHARS} chars).`, "warning");
        return;
      }
      const secretError = services.checkNoSecrets(objective, "Goal objective");
      if (secretError) {
        ctx.ui.notify(`Refusing to store goal objective: ${secretError}.`, "warning");
        return;
      }
      const scaffold = await services.loadScaffold(ctx.cwd, "default");
      const goal = await services.writeGoal(createStoredGoal({
        id: services.makeId(),
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        objective,
        scaffold: scaffold.id,
        createdAt: services.now(),
        updatedAt: services.now(),
        noteTimestamp: services.now(),
        noteText: "Goal created. Do not store secrets in goal notes.",
        maxIterations,
        reviewEvery: scaffold.policy.reviewEvery,
      }));
      services.updateStatus(ctx, goal);
      ctx.ui.notify(`Goal started. State: ${services.goalPath(goal.id)}`, "info");
      services.queueContinuation(pi, ctx, goal);
    },
  });
}
