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
    evidence: Array.isArray(goal.evidence) ? goal.evidence : [],
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
  if (!["ready_to_complete", "not_ready", "blocked"].includes(review.verdict)) throw new Error(`Invalid review verdict: ${review.verdict}`);
  if (!Array.isArray(review.findings) || review.findings.length === 0 || review.findings.some((item) => !item?.trim())) throw new Error("Review findings are required.");
  if (!review.evidenceSummary?.trim()) throw new Error("Review evidenceSummary is required.");
  if ((review.verdict === "not_ready" || review.verdict === "blocked") && (!Array.isArray(review.unresolvedGaps) || review.unresolvedGaps.length === 0)) {
    throw new Error(`Review verdict ${review.verdict} requires unresolvedGaps.`);
  }
}

export function completionReadiness(goal) {
  const normalized = normalizeGoal(goal);
  const missing = [];
  for (const criterion of normalized.criteria) {
    if (criterion.status !== "passed") missing.push(`${criterion.id} is ${criterion.status}`);
    else if (!criterion.evidence?.trim()) missing.push(`${criterion.id} is missing evidence`);
  }
  const latestReview = normalized.reviews.at(-1);
  if (!latestReview) missing.push("terminal review is missing");
  else {
    if (latestReview.verdict !== "ready_to_complete") missing.push(`latest review verdict is ${latestReview.verdict}`);
    if (latestReview.unresolvedGaps?.length) missing.push("latest review has unresolved gaps");
  }
  if (normalized.status === "blocked") missing.push("goal is blocked");
  return { ready: missing.length === 0, missing };
}
