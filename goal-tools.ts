import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createStoredGoal } from "./goal-factory.ts";
import { scaffoldPolicyText } from "./goal-scaffolds.ts";
import type { GoalCriterion, GoalScaffold, StoredGoal } from "./goal-types.ts";
import { applyCriterionUpdates, applyGoalReviewerReport, completionReadiness, isTerminalGoal, normalizeCriteriaInputs, normalizePhases, recommendScaffoldId, validateGoalAgentReport } from "./goal-core.mjs";
import { checkReportForSecrets } from "./goal-reports.ts";

const MAX_OBJECTIVE_CHARS = 4000;

export interface GoalToolServices {
  readCurrentGoal(cwd: string): Promise<StoredGoal | undefined>;
  writeGoal(goal: StoredGoal): Promise<StoredGoal>;
  mutateCurrentGoal(cwd: string, mutator: (goal: StoredGoal) => StoredGoal): Promise<StoredGoal | undefined>;
  reloadRuntime(ctx: ExtensionContext): Promise<StoredGoal | undefined>;
  updateStatus(ctx: ExtensionContext, goal: StoredGoal | undefined): void;
  queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): void;
  listScaffolds(cwd: string): Promise<GoalScaffold[]>;
  loadScaffold(cwd: string, id?: string): Promise<GoalScaffold>;
  checkNoSecrets(value: string | undefined, label: string): string | undefined;
  now(): string;
  makeId(): string;
  goalPath(id: string): string;
  goalForModel(goal: StoredGoal): StoredGoal;
  renderGoalForModel(goal: StoredGoal): string;
  readSessionFile(path: string): Promise<string>;
}

export function registerGoalTools(pi: ExtensionAPI, services: GoalToolServices): void {
  const {
    checkNoSecrets, goalForModel, goalPath, listScaffolds, loadScaffold, makeId,
    mutateCurrentGoal, now: nowIso, queueContinuation, readCurrentGoal,
    readSessionFile, reloadRuntime, renderGoalForModel, updateStatus, writeGoal,
  } = services;
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
      const raw = await readSessionFile(selected.sessionFile);
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

}
