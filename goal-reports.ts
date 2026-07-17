import { detectSecret } from "./secret-detection.mjs";
import type { GoalAgentReport, GoalEvidenceRef, GoalScaffold, StoredGoal } from "./goal-types.ts";
import { applyGoalAgentReport, formatEvidenceRefs, normalizeGoalAgentReportShape, validateGoalAgentReport } from "./goal-core.mjs";

function checkNoSecrets(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const match = detectSecret(value);
  return match ? `${label} contains a possible secret (${match})` : undefined;
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("Goal worker did not return a JSON object.");
}

export function parseGoalAgentReport(text: string, expectedRole: GoalAgentReport["role"]): GoalAgentReport {
  const parsed = JSON.parse(extractJsonObject(text));
  const report = validateGoalAgentReport(normalizeGoalAgentReportShape(parsed)) as GoalAgentReport;
  if (report.role !== expectedRole) throw new Error(`Expected ${expectedRole} report, got ${report.role}.`);
  return report;
}

export const GOAL_AGENT_REPORT_CONTRACT = {
  required: ["schemaVersion: 1", "role", "outcome", "summary: string", "confidence: low|medium|high", "actions: Action[]", "evidence: Evidence[]"],
  outcomesByRole: {
    worker: ["progress", "no_progress", "waiting", "blocked", "ready_for_review"],
    observer: ["progress", "no_progress", "waiting", "blocked"],
    researcher: ["progress", "no_progress", "waiting", "blocked"],
    reviewer: ["review_complete"],
  },
  conditional: {
    nextAction: "required except blocked, waiting, ready_for_review, and review_complete",
    blocked: "blocker.reason, blocker.needed, and non-empty blocker.evidence required",
    waiting: "wait.condition and wait.resumeTrigger required",
    reviewer: "verdict and non-empty findings required; non-ready verdict requires non-empty unresolvedGaps; ready verdict omits unresolvedGaps",
    criteriaUpdate: "add requires text; update_status requires id; passed requires non-empty evidence",
  },
  nested: {
    Action: { summary: "string", evidence: "Evidence[] (optional)" },
    Evidence: { kind: "command|file|test|url|session|observation|artifact", ref: "string", summary: "string", status: "passed|failed|observed|created|modified|not_run (optional)" },
    proposedState: { factsToAdd: "string[]", assumptionsToAdd: "string[]", risksToAdd: "string[]", blockersToAdd: "string[]", evidenceToAdd: "Evidence[]", pinnedEvidenceToAdd: "Evidence[]", checklist: "{text:string,done:boolean,evidence?:string}[]" },
    criteriaUpdates: "{operation:add|update_status,id?:string,text?:string,status?:pending|passed|failed,evidence?:Evidence[],phaseId?:string}[]",
    blocker: "{reason:string,needed:string,evidence:Evidence[]}",
    wait: "{condition:string,resumeTrigger:string}",
    reviewer: { verdict: "ready_to_complete|not_ready|blocked", findings: "string[]", unresolvedGaps: "string[] (required when non-ready)", criteriaAssessment: "{id:string,status:proven|not_proven|contradicted|missing_evidence,reason:string,evidence?:Evidence[]}[]", phaseTransition: "{toPhaseId:string,evidence?:Evidence[]}" },
    researcher: { findings: "string[]", openQuestions: "string[]", recommendedDoctrine: "string[]" },
  },
} as const;

export function reportContract(role: GoalAgentReport["role"]): object {
  return { ...GOAL_AGENT_REPORT_CONTRACT, role };
}

export class NonRetryableReportError extends Error {
  readonly nonRetryable = true;
  sessionFile?: string;

  constructor(message: string, sessionFile?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableReportError";
    this.sessionFile = sessionFile;
  }
}

export function isNonRetryableContinuationError(error: unknown): boolean {
  return error instanceof NonRetryableReportError;
}

export function evidenceText(items: GoalEvidenceRef[] | undefined): string[] {
  return formatEvidenceRefs(items) as string[];
}

export function applyDelegatedReport(goal: StoredGoal, report: GoalAgentReport, scaffold: GoalScaffold): StoredGoal {
  if (checkReportForSecrets(report)) throw new NonRetryableReportError("Refusing secret-bearing goal agent report.");
  return applyGoalAgentReport(goal, report, scaffold) as StoredGoal;
}

export function checkReportForSecrets(report: GoalAgentReport): string | undefined {
  const evidenceRefs = [
    ...(report.evidence ?? []),
    ...(report.proposedState?.evidenceToAdd ?? []),
    ...(report.proposedState?.pinnedEvidenceToAdd ?? []),
    ...(report.blocker?.evidence ?? []),
    ...(report.actions ?? []).flatMap((item) => item.evidence ?? []),
    ...(report.criteriaUpdates ?? []).flatMap((item) => item.evidence ?? []),
    ...(report.criteriaAssessment ?? []).flatMap((item) => item.evidence ?? []),
    ...(report.phaseTransition?.evidence ?? []),
  ];
  const texts = [
    report.summary,
    report.nextAction,
    report.blocker?.reason,
    report.blocker?.needed,
    report.wait?.condition,
    report.wait?.resumeTrigger,
    report.commentary,
    ...(report.actions ?? []).map((item) => item.summary),
    ...(report.proposedState?.factsToAdd ?? []),
    ...(report.proposedState?.assumptionsToAdd ?? []),
    ...(report.proposedState?.risksToAdd ?? []),
    ...(report.proposedState?.blockersToAdd ?? []),
    ...(report.proposedState?.checklist ?? []).flatMap((item) => [item.text, item.evidence]),
    ...(report.criteriaUpdates ?? []).flatMap((item) => [item.id, item.text, item.phaseId]),
    ...(report.phaseTransition ? [report.phaseTransition.toPhaseId] : []),
    ...(report.findings ?? []),
    ...(report.unresolvedGaps ?? []),
    ...(report.scopeConcerns ?? []),
    ...(report.openQuestions ?? []),
    ...(report.recommendedDoctrine ?? []),
    ...(report.criteriaAssessment ?? []).flatMap((item) => [item.id, item.reason]),
    ...evidenceText(evidenceRefs),
  ];
  return texts.map((text) => checkNoSecrets(text, "goal agent report")).find(Boolean);
}

