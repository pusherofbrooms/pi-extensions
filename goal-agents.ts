import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentThinkingLevel } from "./agent-runner.ts";
import { createBashReadOnlyExtension } from "./bash-read-only.ts";
import { parseFrontmatter } from "./goal-scaffolds.ts";
import type { GoalAgentReport, GoalRuntimeDeps, GoalScaffold, StoredGoal } from "./goal-types.ts";
import { buildGoalContextPacket, nextGoalPhase, selectGoalWorkflowPlan } from "./goal-core.mjs";
import { detectSecret } from "./secret-detection.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReportForSecrets, NonRetryableReportError, parseGoalAgentReport, reportContract } from "./goal-reports.ts";

const MODULE_DIR = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const GOAL_WORKER_AGENT_PATH = join(MODULE_DIR, "goal-agents", "goal-worker.md");
const GOAL_OBSERVER_AGENT_PATH = join(MODULE_DIR, "goal-agents", "goal-observer.md");
const GOAL_RESEARCHER_AGENT_PATH = join(MODULE_DIR, "goal-agents", "goal-researcher.md");
const GOAL_PARENT_REVIEWER_AGENT_PATH = join(MODULE_DIR, "goal-agents", "goal-parent-reviewer.md");

function goalForModel(goal: StoredGoal): StoredGoal {
  const { continuationQueued: _queued, lastContinuationAt: _last, ...safeGoal } = goal;
  return safeGoal;
}

function checkNoSecrets(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  // Keep malformed raw output under the same secret policy as persisted reports.
  const match = detectSecret(value);
  return match ? `${label} contains a possible secret (${match})` : undefined;
}

export async function parseOrRepairGoalAgentReport(
  result: { text: string; sessionFile?: string },
  expectedRole: GoalAgentReport["role"],
  goal: StoredGoal,
  ctx: ExtensionContext,
  systemPromptPath: string,
  thinkingLevel: AgentThinkingLevel,
  deps: GoalRuntimeDeps,
): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  try {
    const report = parseGoalAgentReport(result.text, expectedRole);
    if (checkReportForSecrets(report)) throw new NonRetryableReportError(`Refusing secret-bearing ${expectedRole} report.`, result.sessionFile);
    return { report, sessionFile: result.sessionFile };
  } catch (initialError) {
    if (initialError instanceof NonRetryableReportError) throw initialError;
    if (checkNoSecrets(result.text, "raw agent output")) {
      throw new NonRetryableReportError(`Refusing secret-bearing malformed ${expectedRole} report.`, result.sessionFile);
    }
    try {
      const repair = await runIsolatedAgent(goal, ctx, systemPromptPath, `Reformat the existing agent output below. Do not redo, verify, or extend the work. Preserve its meaning and evidence; only correct JSON/schema formatting. Return JSON only.\n\nExpected contract:\n${JSON.stringify(reportContract(expectedRole))}\n\nValidator feedback:\n${(initialError as Error).message}\n\nExisting output:\n${result.text}`, [], deps, thinkingLevel, true);
      try {
        const report = parseGoalAgentReport(repair.text, expectedRole);
        if (checkReportForSecrets(report)) throw new NonRetryableReportError(`Refusing secret-bearing repaired ${expectedRole} report.`, repair.sessionFile ?? result.sessionFile);
        return { report, sessionFile: result.sessionFile, repairSessionFile: repair.sessionFile };
      } catch (error) {
        throw new NonRetryableReportError(`Report repair produced an invalid ${expectedRole} report: ${(error as Error).message}`, repair.sessionFile ?? result.sessionFile, { cause: error });
      }
    } catch (error) {
      if (error instanceof NonRetryableReportError) throw error;
      throw new NonRetryableReportError(`Unable to repair invalid ${expectedRole} report: ${(error as Error).message}`, (error as Error & { sessionFile?: string }).sessionFile ?? result.sessionFile, { cause: error as Error });
    }
  }
}


export function delegatedPrompt(goal: StoredGoal, scaffold: GoalScaffold, workflowPlan = selectGoalWorkflowPlan(scaffold), priorRoleReports: GoalAgentReport[] = []): string {
  const contextPacket = buildGoalContextPacket(goalForModel(goal), scaffold, {
    role: "worker",
    action: workflowPlan.workerAction,
    workflow: workflowPlan.workflow,
    workflowRoles: workflowPlan.roles,
    operatingCycle: workflowPlan.operatingCycle === true,
    priorRoleReports,
    reportContractHint: {
      schemaVersion: 1,
      role: "worker",
      contract: reportContract("worker"),
      returnOnlyJson: true,
      required: ["schemaVersion", "role", "outcome", "summary", "confidence", "actions", "evidence"],
      outcomes: ["progress", "no_progress", "waiting", "blocked", "ready_for_review"],
      conditional: { progress: ["nextAction"], no_progress: ["nextAction"], waiting: ["wait"], blocked: ["blocker"] },
    },
  });
  return `Execute the requested /goal work. Use prior role reports without repeating their inspection unless verification is needed. Work only in the current phase. For operations, continue safe high-value actions until a real wait, resource, or uncertainty gate; otherwise complete one bounded unit. Propose criteria when a complex goal has none. Use ready_for_review when the current phase or goal is proven ready.

Context packet:
${JSON.stringify(contextPacket)}

Return only GoalAgentReport v1 JSON matching reportContractHint. Set confidence to exactly one of "low", "medium", or "high". Optional fields: proposedState, criteriaUpdates, blocker, wait, nextAction. Omit unused fields.`;
}

export function observerPrompt(goal: StoredGoal, scaffold: GoalScaffold, workflowPlan = selectGoalWorkflowPlan(scaffold)): string {
  const contextPacket = buildGoalContextPacket(goalForModel(goal), scaffold, {
    role: "observer",
    action: "inspect_current_state",
    workflow: workflowPlan.workflow,
    workflowRoles: workflowPlan.roles,
    reportContractHint: {
      schemaVersion: 1,
      role: "observer",
      contract: reportContract("observer"),
      returnOnlyJson: true,
      required: ["schemaVersion", "role", "outcome", "summary", "confidence", "actions", "evidence"],
      outcomes: ["progress", "no_progress", "waiting", "blocked"],
      conditional: { progress: ["inspection evidence", "nextAction"], no_progress: ["nextAction"], waiting: ["wait"], blocked: ["blocker"] },
    },
  });
  return `Inspect current state for the requested /goal action without mutation.

Context packet:
${JSON.stringify(contextPacket)}

Return only GoalAgentReport v1 JSON matching reportContractHint. Set confidence to exactly one of "low", "medium", or "high". Put observations in summary/evidence/factsToAdd, risks in risksToAdd, bottlenecks in blockersToAdd, and the worker recommendation in nextAction. Omit unused fields.`;
}

export function researcherPrompt(goal: StoredGoal, scaffold: GoalScaffold, workflowPlan = selectGoalWorkflowPlan(scaffold)): string {
  const contextPacket = buildGoalContextPacket(goalForModel(goal), scaffold, {
    role: "researcher",
    action: "resolve_uncertainty",
    workflow: workflowPlan.workflow,
    workflowRoles: workflowPlan.roles,
    reportContractHint: {
      schemaVersion: 1,
      role: "researcher",
      contract: reportContract("researcher"),
      returnOnlyJson: true,
      required: ["schemaVersion", "role", "outcome", "summary", "confidence", "actions", "evidence"],
      outcomes: ["progress", "no_progress", "waiting", "blocked"],
      conditional: { progress: ["research evidence", "nextAction"], no_progress: ["nextAction"], waiting: ["wait"], blocked: ["blocker"] },
    },
  });
  return `Resolve the bounded uncertainty for the requested /goal action without mutation.

Context packet:
${JSON.stringify(contextPacket)}

Return only GoalAgentReport v1 JSON matching reportContractHint. Set confidence to exactly one of "low", "medium", or "high". Put conclusions in findings, uncertainty in openQuestions, reusable guidance in recommendedDoctrine, durable updates in proposedState, and the worker recommendation in nextAction. Omit unused fields.`;
}

async function loadAgentSystemPrompt(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  return parseFrontmatter(raw).body;
}

export async function runIsolatedAgent(
  goal: StoredGoal,
  ctx: ExtensionContext,
  systemPromptPath: string,
  prompt: string,
  tools: string[],
  deps: GoalRuntimeDeps,
  thinkingLevel: AgentThinkingLevel,
  readOnlyInspection = false,
): Promise<{ text: string; sessionFile?: string }> {
  const result = await deps.runAgent({
    cwd: goal.cwd,
    systemPrompt: await loadAgentSystemPrompt(systemPromptPath),
    prompt,
    tools,
    model: ctx.model,
    thinkingLevel,
    inlineExtensions: readOnlyInspection ? [{ name: "goal-bash-read-only", factory: createBashReadOnlyExtension({ allowGlobalAdditions: false }) }] : undefined,
  });
  if (result.exitCode !== 0) {
    const error = new Error(result.stderr ?? result.errorMessage ?? "Goal subagent failed.") as Error & { sessionFile?: string };
    error.sessionFile = result.sessionFile;
    throw error;
  }
  return { text: result.finalText, sessionFile: result.sessionFile };
}

export async function runGoalObserver(goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: AgentThinkingLevel, workflowPlan = selectGoalWorkflowPlan(scaffold), deps: GoalRuntimeDeps): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  const result = await runIsolatedAgent(
    goal,
    ctx,
    GOAL_OBSERVER_AGENT_PATH,
    observerPrompt(goal, scaffold, workflowPlan),
    ["read", "grep", "find", "ls", "bash_read_only"],
    deps,
    thinkingLevel,
    true,
  );
  return parseOrRepairGoalAgentReport(result, "observer", goal, ctx, GOAL_OBSERVER_AGENT_PATH, thinkingLevel, deps);
}

export async function runGoalResearcher(goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: AgentThinkingLevel, workflowPlan = selectGoalWorkflowPlan(scaffold), deps: GoalRuntimeDeps): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  const result = await runIsolatedAgent(
    goal,
    ctx,
    GOAL_RESEARCHER_AGENT_PATH,
    researcherPrompt(goal, scaffold, workflowPlan),
    ["read", "grep", "find", "ls", "bash_read_only"],
    deps,
    thinkingLevel,
    true,
  );
  return parseOrRepairGoalAgentReport(result, "researcher", goal, ctx, GOAL_RESEARCHER_AGENT_PATH, thinkingLevel, deps);
}

export async function runGoalWorker(goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: AgentThinkingLevel, workflowPlan = selectGoalWorkflowPlan(scaffold), priorRoleReports: GoalAgentReport[] = [], deps: GoalRuntimeDeps): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  const result = await runIsolatedAgent(
    goal,
    ctx,
    GOAL_WORKER_AGENT_PATH,
    delegatedPrompt(goal, scaffold, workflowPlan, priorRoleReports),
    ["read", "grep", "find", "ls", "bash", "edit", "write"],
    deps,
    thinkingLevel,
  );
  return parseOrRepairGoalAgentReport(result, "worker", goal, ctx, GOAL_WORKER_AGENT_PATH, thinkingLevel, deps);
}

export function strategicReviewPrompt(goal: StoredGoal, scaffold: GoalScaffold, workflowPlan = selectGoalWorkflowPlan(scaffold)): string {
  const contextPacket = buildGoalContextPacket(goalForModel(goal), scaffold, {
    role: "reviewer",
    action: "scheduled_strategic_review",
    scheduledReview: true,
    workflow: workflowPlan.workflow,
    workflowRoles: workflowPlan.roles,
    reportContractHint: {
      schemaVersion: 1,
      role: "reviewer",
      contract: reportContract("reviewer"),
      returnOnlyJson: true,
      requiredOutcome: "review_complete",
      verdicts: ["ready_to_complete", "not_ready", "blocked"],
    },
  });
  return `Perform a read-only strategic review of alignment, evidence, stale assumptions, repeated ineffective actions, risks, and next focus. This review cannot complete the goal; normally use not_ready and identify the next gap.

Context packet:
${JSON.stringify(contextPacket)}

Return only GoalAgentReport v1 reviewer JSON matching reportContractHint with outcome=review_complete, summary, confidence (exactly "low", "medium", or "high"), actions, evidence, verdict, findings, criteriaAssessment (empty if not used), and nextAction. Non-ready verdicts require unresolvedGaps.`;
}

export async function runScheduledStrategicReview(goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: AgentThinkingLevel, workflowPlan = selectGoalWorkflowPlan(scaffold), deps: GoalRuntimeDeps): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  const result = await runIsolatedAgent(
    goal,
    ctx,
    GOAL_PARENT_REVIEWER_AGENT_PATH,
    strategicReviewPrompt(goal, scaffold, workflowPlan),
    ["read", "grep", "find", "ls", "bash_read_only"],
    deps,
    thinkingLevel,
    true,
  );
  const parsed = await parseOrRepairGoalAgentReport(result, "reviewer", goal, ctx, GOAL_PARENT_REVIEWER_AGENT_PATH, thinkingLevel, deps);
  return parsed;
}

export function parentReviewPrompt(goal: StoredGoal, workerReport: GoalAgentReport, scaffold: GoalScaffold): string {
  const phaseGate = Boolean(nextGoalPhase(goalForModel(goal)));
  const contextPacket = buildGoalContextPacket(goalForModel(goal), scaffold, {
    role: "reviewer",
    action: phaseGate ? "phase_gate_review" : "terminal_review",
    reportContractHint: {
      schemaVersion: 1,
      role: "reviewer",
      contract: reportContract("reviewer"),
      returnOnlyJson: true,
      requiredOutcome: "review_complete",
      verdicts: ["ready_to_complete", "not_ready", "blocked"],
      assessEveryCurrentCriterion: true,
    },
  });
  return `Verify the worker's readiness claim using read-only inspection or lightweight checks as needed. Assess every current criterion exactly once. Return ready_to_complete only when each is proven by concrete evidence. ${phaseGate ? "For a ready phase gate, include phaseTransition.toPhaseId for the immediate next phase; this does not complete the goal." : "For a terminal review, verify the whole objective."}

Context packet:
${JSON.stringify(contextPacket)}

Worker report:
${JSON.stringify(workerReport)}

Return only GoalAgentReport v1 reviewer JSON matching reportContractHint with outcome=review_complete, summary, confidence (exactly "low", "medium", or "high"), actions, evidence, verdict, findings, and criteriaAssessment[{id,status,reason,evidence}]. Non-ready verdicts require unresolvedGaps; ready verdicts must omit them. Optional: commentary, scopeConcerns, phaseTransition.`;
}

export async function runParentReview(goal: StoredGoal, workerReport: GoalAgentReport, scaffold: GoalScaffold, ctx: ExtensionContext, thinkingLevel: AgentThinkingLevel, deps: GoalRuntimeDeps): Promise<{ report: GoalAgentReport; sessionFile?: string; repairSessionFile?: string }> {
  const result = await runIsolatedAgent(
    goal,
    ctx,
    GOAL_PARENT_REVIEWER_AGENT_PATH,
    parentReviewPrompt(goal, workerReport, scaffold),
    ["read", "grep", "find", "ls", "bash_read_only"],
    deps,
    thinkingLevel,
    true,
  );
  const parsed = await parseOrRepairGoalAgentReport(result, "reviewer", goal, ctx, GOAL_PARENT_REVIEWER_AGENT_PATH, thinkingLevel, deps);
  return parsed;
}

