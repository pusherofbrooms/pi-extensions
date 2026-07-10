export function isTerminalGoal(goal) {
  return goal?.status === "complete" || goal?.status === "cleared";
}

export function normalizeGoal(goal) {
  return {
    ...goal,
    scaffold: typeof goal.scaffold === "string" && goal.scaffold.trim() ? goal.scaffold : "default",
    criteria: Array.isArray(goal.criteria) ? goal.criteria : [],
    reviews: Array.isArray(goal.reviews) ? goal.reviews : [],
    facts: Array.isArray(goal.facts) ? goal.facts : [],
    assumptions: Array.isArray(goal.assumptions) ? goal.assumptions : [],
    risks: Array.isArray(goal.risks) ? goal.risks : [],
    blockers: Array.isArray(goal.blockers) ? goal.blockers : [],
    blockerHistory: Array.isArray(goal.blockerHistory) ? goal.blockerHistory : [],
    doctrine: Array.isArray(goal.doctrine) ? goal.doctrine : [],
    evidence: Array.isArray(goal.evidence) ? goal.evidence : [],
    pinnedEvidence: Array.isArray(goal.pinnedEvidence) ? goal.pinnedEvidence : [],
    roleCheckpoints: Array.isArray(goal.roleCheckpoints) ? goal.roleCheckpoints : [],
    iterations: Array.isArray(goal.iterations) ? goal.iterations : [],
  };
}

export function nextCriterionId(existing = []) {
  const used = new Set(existing.map((item) => item.id));
  for (let i = 1; i < 10000; i += 1) {
    const id = `CRIT-${String(i).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Unable to allocate criterion id.");
}

export function normalizeCriteriaInputs(inputs, existing = []) {
  const result = [];
  const seen = new Set();
  for (const input of inputs ?? []) {
    const id = input.id?.trim() || nextCriterionId([...existing, ...result]);
    const text = input.text?.trim() ?? "";
    if (!text) throw new Error("Criterion text is required.");
    if (seen.has(id)) throw new Error(`Duplicate criterion id: ${id}`);
    seen.add(id);
    const status = input.status ?? "pending";
    if (!["pending", "passed", "failed"].includes(status)) throw new Error(`Invalid criterion status: ${status}`);
    if (status === "passed" && !input.evidence?.trim()) throw new Error(`Criterion ${id} requires evidence to be marked passed.`);
    result.push({ id, text, status, evidence: input.evidence?.trim() || undefined });
  }
  return result;
}

export function appendUniqueStrings(existing = [], incoming = [], maxItems = 50) {
  const result = [];
  const seen = new Set();
  for (const value of [...(existing ?? []), ...(incoming ?? [])]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.slice(-maxItems);
}

export function mergeCriteria(existing = [], proposed = [], updates = []) {
  let criteria = [...(existing ?? [])];
  if (proposed?.length) {
    const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    const additions = [];
    for (const input of proposed) {
      const normalized = normalizeCriteriaInputs([input], [...criteria, ...additions])[0];
      if (byId.has(normalized.id)) {
        const current = byId.get(normalized.id);
        const replacement = { ...current, text: normalized.text, status: input.status ?? current.status, evidence: normalized.evidence ?? current.evidence };
        byId.set(normalized.id, replacement);
        criteria = criteria.map((criterion) => criterion.id === normalized.id ? replacement : criterion);
      } else {
        additions.push(normalized);
        byId.set(normalized.id, normalized);
      }
    }
    criteria = [...criteria, ...additions];
  }
  return updates?.length ? applyCriterionUpdates(criteria, updates) : criteria;
}

export function blockedStatusFromReport(report, policy = {}) {
  if (report?.outcome !== "blocked") return { blocked: false };
  const blockers = Array.isArray(report.blockers) ? report.blockers.filter((item) => typeof item === "string" && item.trim()) : [];
  const evidence = Array.isArray(report.evidence) ? report.evidence.filter((item) => typeof item === "string" && item.trim()) : [];
  if (policy.blockedPolicy === "external-blocker-only" || policy.blockedPolicy === "strict") {
    if (!blockers.length || !evidence.length) {
      return { blocked: false, reason: "Blocked outcome downgraded: strict policy requires blocker text and evidence." };
    }
  }
  return { blocked: true };
}

export function waitingStatusFromReport(report, policy = {}) {
  if (report?.outcome !== "waiting") return { waiting: false };
  if (policy.waitingAllowed === true) return { waiting: true };
  return { waiting: false, reason: "Waiting outcome downgraded: scaffold policy does not allow waiting as a terminal step outcome." };
}

export function recommendScaffoldId(objective = "") {
  const text = String(objective).toLowerCase();
  if (/bitburner|daemon|server|session|monitor|operate|automation|running|deploy|live/.test(text)) return "operations";
  if (/long[- ]?horizon|phase|milestone|gap|finish|complete|implement|fix|build|test/.test(text)) return "zenith";
  return "default";
}

const SUPPORTED_WORKFLOWS = ["worker", "worker-reviewer", "observer-worker", "research-worker", "operations"];

export function selectGoalWorkflowPlan(scaffold = {}) {
  const rawWorkflow = typeof scaffold?.policy?.workflow === "string" ? scaffold.policy.workflow.trim().toLowerCase() : "";
  const workflow = SUPPORTED_WORKFLOWS.includes(rawWorkflow) ? rawWorkflow : "worker";
  const fallbackReason = rawWorkflow && rawWorkflow !== workflow ? `Unknown scaffold workflow '${rawWorkflow}' fell back to worker.` : undefined;
  const reviewOnReady = scaffold?.policy?.completionPolicy !== "worker-only";
  const plans = {
    worker: { workflow, roles: ["worker"], workerAction: "continue", reviewOnReady, lifecycleAuthority: "orchestrator" },
    "worker-reviewer": { workflow, roles: ["worker", "reviewer"], workerAction: "continue", reviewOnReady: true, lifecycleAuthority: "orchestrator" },
    "observer-worker": { workflow, roles: ["observer", "worker"], workerAction: "continue_after_observation", reviewOnReady, lifecycleAuthority: "orchestrator" },
    "research-worker": { workflow, roles: ["researcher", "worker"], workerAction: "continue_after_research", reviewOnReady, lifecycleAuthority: "orchestrator" },
    operations: { workflow, roles: ["worker"], workerAction: "operations_cycle", reviewOnReady, lifecycleAuthority: "orchestrator", operatingCycle: true },
  };
  return { ...plans[workflow], fallbackReason };
}

export function appendGoalRoleCheckpoint(goal, checkpoint, maxItems = 20) {
  return {
    ...goal,
    roleCheckpoints: [...(goal.roleCheckpoints ?? []), checkpoint].slice(-maxItems),
  };
}

export function buildGoalContextPacket(goal, scaffold, request = {}) {
  const normalized = normalizeGoal(goal ?? {});
  const latestReview = normalized.reviews.at(-1) ?? null;
  return {
    schemaVersion: 1,
    goal: {
      id: normalized.id,
      objective: normalized.objective,
      status: normalized.status,
      cwd: normalized.cwd,
      stepCount: normalized.stepCount ?? 0,
      maxIterations: normalized.maxIterations,
      scaffold: normalized.scaffold ?? scaffold?.id ?? "default",
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      stopReason: normalized.stopReason,
      nextAction: normalized.nextAction,
    },
    criteria: normalized.criteria,
    state: {
      summary: normalized.summary ?? "",
      checklist: normalized.checklist ?? [],
      facts: normalized.facts,
      assumptions: normalized.assumptions,
      risks: normalized.risks,
      blockers: normalized.blockers,
      blockerHistory: normalized.blockerHistory,
      doctrine: normalized.doctrine,
      evidence: normalized.evidence,
      pinnedEvidence: normalized.pinnedEvidence,
      roleCheckpoints: normalized.roleCheckpoints.slice(-8),
      latestReview,
      recentNotes: Array.isArray(normalized.notes) ? normalized.notes.slice(-8) : [],
      recentIterations: normalized.iterations.slice(-5),
    },
    scaffold: scaffold ? {
      id: scaffold.id,
      name: scaffold.name,
      description: scaffold.description,
      body: scaffold.body,
      source: scaffold.source,
      path: scaffold.path,
      policy: scaffold.policy ?? {},
    } : undefined,
    request: {
      role: request.role ?? "worker",
      action: request.action ?? "continue",
      scheduledReview: request.scheduledReview === true,
      workflow: request.workflow,
      workflowRoles: request.workflowRoles,
      operatingCycle: request.operatingCycle === true,
      priorRoleReports: Array.isArray(request.priorRoleReports) ? request.priorRoleReports : [],
    },
    reportContractHint: request.reportContractHint ?? {
      schemaVersion: 1,
      returnOnlyJson: true,
      lifecycleAuthority: "orchestrator",
    },
  };
}

export function applyCriterionUpdates(criteria, updates) {
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  for (const update of updates ?? []) {
    if (!byId.has(update.id)) throw new Error(`Unknown criterion id: ${update.id}`);
    if (!["pending", "passed", "failed"].includes(update.status)) throw new Error(`Invalid criterion status: ${update.status}`);
    if (update.status === "passed" && !update.evidence?.trim()) throw new Error(`Criterion ${update.id} requires evidence to be marked passed.`);
    const current = byId.get(update.id);
    byId.set(update.id, { ...current, status: update.status, evidence: update.evidence?.trim() || current.evidence });
  }
  return criteria.map((criterion) => byId.get(criterion.id));
}

export function validateReview(review) {
  if (review.kind !== undefined && !["terminal", "strategic"].includes(review.kind)) throw new Error(`Invalid review kind: ${review.kind}`);
  if (!["ready_to_complete", "not_ready", "blocked"].includes(review.verdict)) throw new Error(`Invalid review verdict: ${review.verdict}`);
  if (!Array.isArray(review.findings) || review.findings.length === 0 || review.findings.some((item) => !item?.trim())) throw new Error("Review findings are required.");
  if (!review.evidenceSummary?.trim()) throw new Error("Review evidenceSummary is required.");
  if ((review.verdict === "not_ready" || review.verdict === "blocked") && (!Array.isArray(review.unresolvedGaps) || review.unresolvedGaps.length === 0)) {
    throw new Error(`Review verdict ${review.verdict} requires unresolvedGaps.`);
  }
}

export function latestTerminalReview(reviews = []) {
  return [...(reviews ?? [])].reverse().find((review) => (review.kind ?? "terminal") === "terminal");
}

function reviewHasStructuredEvidence(review) {
  if (Array.isArray(review?.evidence) && review.evidence.length > 0) return true;
  return (review?.criteriaAssessment ?? []).some((item) => Array.isArray(item.evidence) && item.evidence.length > 0);
}

export function completionReadiness(goal) {
  const normalized = normalizeGoal(goal);
  const missing = [];
  for (const criterion of normalized.criteria) {
    if (criterion.status !== "passed") missing.push(`${criterion.id} is ${criterion.status}`);
    else if (!criterion.evidence?.trim()) missing.push(`${criterion.id} is missing evidence`);
  }
  const terminalReview = latestTerminalReview(normalized.reviews);
  if (!terminalReview) missing.push("terminal review is missing");
  else {
    if (terminalReview.verdict !== "ready_to_complete") missing.push(`latest terminal review verdict is ${terminalReview.verdict}`);
    if (terminalReview.unresolvedGaps?.length) missing.push("latest terminal review has unresolved gaps");
    if (!reviewHasStructuredEvidence(terminalReview)) missing.push("latest terminal review is missing structured evidence");
    missing.push(...reviewerCriteriaAssessmentGaps(normalized.criteria, Array.isArray(terminalReview.criteriaAssessment) ? terminalReview.criteriaAssessment : [], { requireProven: true }));
  }
  if (normalized.status === "blocked") missing.push("goal is blocked");
  return { ready: missing.length === 0, missing };
}

const REPORT_ROLES = ["worker", "reviewer", "observer", "researcher", "experimenter"];
const REPORT_OUTCOMES = ["progress", "no_progress", "waiting", "blocked", "ready_for_review", "review_complete"];
const REPORT_CONFIDENCE = ["low", "medium", "high"];
const EVIDENCE_KINDS = ["command", "file", "test", "url", "session", "observation", "artifact"];
const EVIDENCE_STATUSES = ["passed", "failed", "observed", "created", "modified", "not_run"];
const CRITERION_OPERATIONS = ["add", "update_status"];
const CRITERIA_ASSESSMENT_STATUSES = ["proven", "not_proven", "contradicted", "missing_evidence"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateEvidenceRef(item, path) {
  if (!item || typeof item !== "object") throw new Error(`${path} must be an object.`);
  if (!EVIDENCE_KINDS.includes(item.kind)) throw new Error(`${path}.kind is invalid.`);
  if (!isNonEmptyString(item.ref)) throw new Error(`${path}.ref is required.`);
  if (!isNonEmptyString(item.summary)) throw new Error(`${path}.summary is required.`);
  if (item.status !== undefined && !EVIDENCE_STATUSES.includes(item.status)) throw new Error(`${path}.status is invalid.`);
}

function validateStringArray(value, path, required = false) {
  if (value === undefined) {
    if (required) throw new Error(`${path} is required.`);
    return;
  }
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) throw new Error(`${path} must be an array of non-empty strings.`);
}

function validateCriteriaAssessmentItems(value, path = "criteriaAssessment") {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  value.forEach((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${path}[${index}] must be an object.`);
    if (!isNonEmptyString(item.id)) throw new Error(`${path}[${index}].id is required.`);
    if (!CRITERIA_ASSESSMENT_STATUSES.includes(item.status)) throw new Error(`${path}[${index}].status is invalid.`);
    if (!isNonEmptyString(item.reason)) throw new Error(`${path}[${index}].reason is required.`);
    if (item.evidence !== undefined) {
      if (!Array.isArray(item.evidence)) throw new Error(`${path}[${index}].evidence must be an array.`);
      item.evidence.forEach((evidence, evidenceIndex) => validateEvidenceRef(evidence, `${path}[${index}].evidence[${evidenceIndex}]`));
    }
  });
}

function reviewerCriteriaAssessmentGaps(criteria = [], criteriaAssessment = [], { requireProven = false } = {}) {
  const gaps = [];
  const expectedIds = new Set((criteria ?? []).map((criterion) => criterion.id));
  const seen = new Set();
  for (const item of criteriaAssessment ?? []) {
    if (seen.has(item.id)) gaps.push(`${item.id} has duplicate reviewer assessments`);
    seen.add(item.id);
    if (!expectedIds.has(item.id)) gaps.push(`${item.id} is not a current criterion`);
  }
  for (const criterion of criteria ?? []) {
    const assessment = (criteriaAssessment ?? []).find((item) => item.id === criterion.id);
    if (!assessment) gaps.push(`${criterion.id} is missing reviewer assessment`);
    else if (requireProven && assessment.status !== "proven") gaps.push(`${criterion.id} reviewer assessment is ${assessment.status}`);
    else if (requireProven && (!Array.isArray(assessment.evidence) || assessment.evidence.length === 0)) gaps.push(`${criterion.id} reviewer assessment is missing evidence`);
  }
  return gaps;
}

export function validateGoalAgentReport(report) {
  if (!report || typeof report !== "object") throw new Error("Report must be an object.");
  if (report.schemaVersion !== 1) throw new Error("Report schemaVersion must be 1.");
  if (!REPORT_ROLES.includes(report.role)) throw new Error(`Invalid report role: ${report.role}`);
  if (!REPORT_OUTCOMES.includes(report.outcome)) throw new Error(`Invalid report outcome: ${report.outcome}`);
  if (!isNonEmptyString(report.summary)) throw new Error("Report summary is required.");
  if (!REPORT_CONFIDENCE.includes(report.confidence)) throw new Error("Report confidence must be low, medium, or high.");
  if (!Array.isArray(report.evidence)) throw new Error("Report evidence must be an array.");
  report.evidence.forEach((item, index) => validateEvidenceRef(item, `evidence[${index}]`));
  if (!Array.isArray(report.actions)) throw new Error("Report actions must be an array.");
  report.actions.forEach((item, index) => {
    if (!item || typeof item !== "object" || !isNonEmptyString(item.summary)) throw new Error(`actions[${index}].summary is required.`);
    if (item.evidence !== undefined) {
      if (!Array.isArray(item.evidence)) throw new Error(`actions[${index}].evidence must be an array.`);
      item.evidence.forEach((evidence, evidenceIndex) => validateEvidenceRef(evidence, `actions[${index}].evidence[${evidenceIndex}]`));
    }
  });
  if (!["blocked", "waiting", "ready_for_review", "review_complete"].includes(report.outcome) && !isNonEmptyString(report.nextAction)) {
    throw new Error("Report nextAction is required unless blocked, waiting, ready_for_review, or review_complete.");
  }
  const proposed = report.proposedState ?? {};
  if (proposed && typeof proposed !== "object") throw new Error("proposedState must be an object.");
  for (const field of ["factsToAdd", "assumptionsToAdd", "risksToAdd", "blockersToAdd"]) validateStringArray(proposed[field], `proposedState.${field}`);
  if (proposed.evidenceToAdd !== undefined) {
    if (!Array.isArray(proposed.evidenceToAdd)) throw new Error("proposedState.evidenceToAdd must be an array.");
    proposed.evidenceToAdd.forEach((item, index) => validateEvidenceRef(item, `proposedState.evidenceToAdd[${index}]`));
  }
  if (proposed.pinnedEvidenceToAdd !== undefined) {
    if (!Array.isArray(proposed.pinnedEvidenceToAdd)) throw new Error("proposedState.pinnedEvidenceToAdd must be an array.");
    proposed.pinnedEvidenceToAdd.forEach((item, index) => validateEvidenceRef(item, `proposedState.pinnedEvidenceToAdd[${index}]`));
  }
  if (report.criteriaUpdates !== undefined) {
    if (!Array.isArray(report.criteriaUpdates)) throw new Error("criteriaUpdates must be an array.");
    report.criteriaUpdates.forEach((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`criteriaUpdates[${index}] must be an object.`);
      if (!CRITERION_OPERATIONS.includes(item.operation)) throw new Error(`criteriaUpdates[${index}].operation is invalid.`);
      if (item.operation === "add" && !isNonEmptyString(item.text)) throw new Error(`criteriaUpdates[${index}].text is required for add.`);
      if (item.operation === "update_status" && !isNonEmptyString(item.id)) throw new Error(`criteriaUpdates[${index}].id is required for update_status.`);
      if (item.status !== undefined && !["pending", "passed", "failed"].includes(item.status)) throw new Error(`criteriaUpdates[${index}].status is invalid.`);
      if (item.status === "passed" && (!Array.isArray(item.evidence) || item.evidence.length === 0)) throw new Error(`criteriaUpdates[${index}] passed status requires evidence.`);
      if (item.evidence !== undefined) {
        if (!Array.isArray(item.evidence)) throw new Error(`criteriaUpdates[${index}].evidence must be an array.`);
        item.evidence.forEach((evidence, evidenceIndex) => validateEvidenceRef(evidence, `criteriaUpdates[${index}].evidence[${evidenceIndex}]`));
      }
    });
  }
  if (report.outcome === "blocked") {
    if (!isNonEmptyString(report.blocker?.reason)) throw new Error("Blocked reports require blocker.reason.");
    if (!isNonEmptyString(report.blocker?.needed)) throw new Error("Blocked reports require blocker.needed.");
    if (!Array.isArray(report.blocker?.evidence) || report.blocker.evidence.length === 0) throw new Error("Blocked reports require blocker.evidence.");
    report.blocker.evidence.forEach((item, index) => validateEvidenceRef(item, `blocker.evidence[${index}]`));
  }
  if (report.outcome === "waiting") {
    if (!isNonEmptyString(report.wait?.condition)) throw new Error("Waiting reports require wait.condition.");
    if (!isNonEmptyString(report.wait?.resumeTrigger)) throw new Error("Waiting reports require wait.resumeTrigger.");
  }
  if (report.openQuestions !== undefined) validateStringArray(report.openQuestions, "openQuestions");
  if (report.recommendedDoctrine !== undefined) validateStringArray(report.recommendedDoctrine, "recommendedDoctrine");
  if (report.role === "observer") {
    if (!["progress", "no_progress", "waiting", "blocked"].includes(report.outcome)) throw new Error("Observer report outcome must be progress, no_progress, waiting, or blocked.");
    if (report.outcome === "progress" && report.evidence.length === 0 && !report.actions.some((item) => item.evidence?.length)) throw new Error("Observer progress reports require inspection evidence.");
  }
  if (report.role === "researcher") {
    if (!["progress", "no_progress", "waiting", "blocked"].includes(report.outcome)) throw new Error("Researcher report outcome must be progress, no_progress, waiting, or blocked.");
    validateStringArray(report.findings, "findings");
    if (report.outcome === "progress" && report.evidence.length === 0 && !report.actions.some((item) => item.evidence?.length)) throw new Error("Researcher progress reports require research evidence.");
  }
  if (report.role === "reviewer") {
    if (!["ready_to_complete", "not_ready", "blocked"].includes(report.verdict)) throw new Error("Reviewer report verdict is invalid.");
    if (!Array.isArray(report.findings) || report.findings.length === 0 || report.findings.some((item) => !isNonEmptyString(item))) throw new Error("Reviewer report findings must be a non-empty array of strings.");
    if (report.verdict !== "ready_to_complete" && (!Array.isArray(report.unresolvedGaps) || report.unresolvedGaps.length === 0)) throw new Error("Non-ready reviewer reports require unresolvedGaps.");
    if (report.verdict === "ready_to_complete" && report.unresolvedGaps?.length) throw new Error("Ready reviewer reports must not include unresolvedGaps.");
    validateCriteriaAssessmentItems(report.criteriaAssessment, "criteriaAssessment");
  }
  return report;
}

export function goalAgentReportEffectiveOutcome(report, policy = {}) {
  if (report?.outcome === "waiting" && policy.waitingAllowed !== true) return "progress";
  if (report?.outcome === "blocked") {
    if (["never", "progress-only"].includes(policy.blockedPolicy)) return "progress";
    if (["external-blocker-only", "strict"].includes(policy.blockedPolicy)) {
      const hasBlocker = isNonEmptyString(report.blocker?.reason) && isNonEmptyString(report.blocker?.needed);
      const hasEvidence = Array.isArray(report.blocker?.evidence) && report.blocker.evidence.length > 0;
      if (!hasBlocker || !hasEvidence) return "progress";
    }
  }
  return report?.outcome;
}

export function criteriaInputsFromGoalAgentReport(report) {
  const proposed = [];
  const updates = [];
  for (const item of report?.criteriaUpdates ?? []) {
    const evidence = formatEvidenceRefs(item.evidence).join("; ") || undefined;
    if (item.operation === "add") {
      proposed.push({ id: item.id, text: item.text ?? "", status: item.status, evidence });
    } else if (item.id && item.status) {
      updates.push({ id: item.id, status: item.status, evidence });
    }
  }
  return { proposed, updates };
}

export function applyGoalAgentReport(goal, report, scaffold = {}, options = {}) {
  const policy = scaffold?.policy ?? {};
  const now = options.now ?? new Date().toISOString();
  const effectiveOutcome = goalAgentReportEffectiveOutcome(report, policy);
  const { proposed, updates } = criteriaInputsFromGoalAgentReport(report);
  const criteria = mergeCriteria(goal.criteria ?? [], proposed, updates);
  const reviewVerdict = effectiveOutcome === "blocked" ? "blocked" : effectiveOutcome === "ready_for_review" ? "ready_to_complete" : "not_ready";
  const shouldRecordReview = effectiveOutcome === "ready_for_review" || effectiveOutcome === "blocked";
  const evidenceRefs = formatEvidenceRefs([...(report.evidence ?? []), ...(report.proposedState?.evidenceToAdd ?? [])]);
  const pinnedEvidenceRefs = formatEvidenceRefs(report.proposedState?.pinnedEvidenceToAdd ?? []);
  const evidenceSummary = [...evidenceRefs, ...pinnedEvidenceRefs].join("; ") || report.summary;
  const review = shouldRecordReview ? {
    timestamp: now,
    verdict: reviewVerdict,
    findings: [report.summary],
    unresolvedGaps: reviewVerdict === "ready_to_complete" ? undefined : [report.blocker?.reason ?? report.nextAction ?? "Continue delegated goal execution."],
    evidenceSummary,
  } : undefined;

  validateReview(review ?? { verdict: "not_ready", findings: ["Delegated progress recorded."], unresolvedGaps: ["Continue."], evidenceSummary: "Delegated progress recorded." });

  const noteParts = [
    `Delegated outcome: ${report.outcome}${effectiveOutcome !== report.outcome ? ` (treated as ${effectiveOutcome})` : ""}. ${report.summary}`,
    report.actions?.length ? `Actions: ${report.actions.map((item) => item.summary).join("; ")}` : undefined,
    report.wait?.condition ? `Wait condition: ${report.wait.condition}` : undefined,
    report.wait?.resumeTrigger ? `Resume trigger: ${report.wait.resumeTrigger}` : undefined,
  ].filter(Boolean);
  const blockerHistoryEntries = effectiveOutcome === "blocked"
    ? [{ timestamp: now, status: "active", reason: report.blocker?.reason ?? report.summary, needed: report.blocker?.needed, evidence: formatEvidenceRefs(report.blocker?.evidence ?? []) }]
    : (report.proposedState?.blockersToAdd ?? []).map((reason) => ({ timestamp: now, status: "potential", reason }));

  return {
    ...goal,
    status: effectiveOutcome === "blocked" ? "blocked" : goal.status,
    stopReason: effectiveOutcome === "blocked" ? "blocked" : goal.stopReason,
    summary: report.summary,
    checklist: report.proposedState?.checklist ?? goal.checklist,
    criteria,
    reviews: review ? [...(goal.reviews ?? []), review].slice(-20) : goal.reviews,
    lastReviewStep: review ? goal.stepCount : goal.lastReviewStep,
    facts: appendUniqueStrings(goal.facts, report.proposedState?.factsToAdd),
    assumptions: appendUniqueStrings(goal.assumptions, report.proposedState?.assumptionsToAdd),
    risks: appendUniqueStrings(goal.risks, report.proposedState?.risksToAdd),
    blockers: effectiveOutcome === "blocked" ? appendUniqueStrings(goal.blockers, [report.blocker?.reason ?? report.summary]) : appendUniqueStrings(goal.blockers, report.proposedState?.blockersToAdd),
    blockerHistory: [...(goal.blockerHistory ?? []), ...blockerHistoryEntries].slice(-50),
    doctrine: appendUniqueStrings(goal.doctrine, report.recommendedDoctrine),
    evidence: appendUniqueStrings(goal.evidence, evidenceRefs),
    pinnedEvidence: appendUniqueStrings(goal.pinnedEvidence, pinnedEvidenceRefs),
    nextAction: effectiveOutcome === "ready_for_review"
      ? "Parent should verify readiness and complete the goal if evidence is sufficient."
      : report.nextAction ?? report.wait?.resumeTrigger ?? report.wait?.condition ?? report.blocker?.needed ?? goal.nextAction,
    notes: [...(goal.notes ?? []), { timestamp: now, text: noteParts.join(" ") }].slice(-50),
    continuationQueued: false,
  };
}

export function applyGoalReviewerReport(goal, report, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const reviewKind = options.reviewKind ?? "terminal";
  validateCriteriaAssessmentItems(report.criteriaAssessment ?? [], "criteriaAssessment");
  const assessmentGaps = reviewKind === "terminal" && report.verdict === "ready_to_complete"
    ? reviewerCriteriaAssessmentGaps(goal.criteria ?? [], report.criteriaAssessment ?? [], { requireProven: true })
    : [];
  if (reviewKind === "terminal" && assessmentGaps.length) throw new Error(`Terminal reviewer criteriaAssessment is incomplete: ${assessmentGaps.join("; ")}`);
  const structuredEvidence = formatEvidenceRefs(report.evidence);
  const criteria = reviewKind === "terminal" && report.verdict === "ready_to_complete"
    ? (goal.criteria ?? []).map((criterion) => {
      const assessment = (report.criteriaAssessment ?? []).find((item) => item.id === criterion.id && item.status === "proven");
      if (!assessment) return criterion;
      return { ...criterion, status: "passed", evidence: formatEvidenceRefs(assessment.evidence).join("; ") || assessment.reason || criterion.evidence };
    })
    : goal.criteria;
  const review = {
    timestamp: now,
    kind: reviewKind,
    verdict: report.verdict,
    findings: report.findings ?? [report.summary],
    unresolvedGaps: report.verdict === "ready_to_complete" ? undefined : report.unresolvedGaps ?? [report.summary],
    evidenceSummary: structuredEvidence.join("; ") || report.summary,
    evidence: structuredEvidence,
    criteriaAssessment: report.criteriaAssessment ?? [],
  };
  validateReview(review);
  const reviewed = {
    ...goal,
    criteria,
    reviews: [...(goal.reviews ?? []), review].slice(-20),
    lastReviewStep: goal.stepCount,
    evidence: appendUniqueStrings(goal.evidence, formatEvidenceRefs(report.evidence)),
    nextAction: reviewKind === "strategic"
      ? report.nextAction ?? review.unresolvedGaps?.[0] ?? "Continue goal execution using the strategic review findings."
      : report.verdict === "ready_to_complete"
        ? "Goal verified complete by parent review."
        : review.unresolvedGaps?.[0] ?? "Address parent verification gaps.",
  };
  if (reviewKind !== "terminal") return reviewed;
  const readiness = completionReadiness(reviewed);
  return {
    ...reviewed,
    status: report.verdict === "ready_to_complete" && readiness.ready ? "complete" : reviewed.status,
  };
}

export function formatEvidenceRef(evidence) {
  if (!evidence || typeof evidence !== "object") return "";
  const status = evidence.status ? `${evidence.status}: ` : "";
  return `${evidence.kind}:${evidence.ref} — ${status}${evidence.summary}`;
}

export function formatEvidenceRefs(items = []) {
  return (Array.isArray(items) ? items : []).map(formatEvidenceRef).filter(Boolean);
}
