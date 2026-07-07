import type { Message } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { detectSecret } from "./secret-detection.mjs";
import { applyCriterionUpdates, completionReadiness, normalizeCriteriaInputs, normalizeGoal, validateReview } from "./goal-core.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OBJECTIVE_CHARS = 4000;
const CONTINUATION_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];
const MODULE_DIR = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const STORE_DIR = join(homedir(), ".pi", "agent", "goals");
const GOALS_DIR = join(STORE_DIR, "goals");
const BUNDLED_SCAFFOLDS_DIR = join(MODULE_DIR, "scaffolds");
const GOAL_WORKER_AGENT_PATH = join(MODULE_DIR, "agents", "goal-worker.md");
const USER_SCAFFOLDS_DIR = join(homedir(), ".pi", "agent", "scaffolds");
const PROJECT_SCAFFOLDS_DIR = ".pi/scaffolds";
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
let shuttingDown = false;

type GoalScaffold = {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "bundled" | "user" | "project";
  path?: string;
};

type DelegatedGoalReport = {
  outcome: "progress" | "waiting" | "blocked" | "ready_to_complete" | "no_progress";
  summary: string;
  actionsTaken?: string[];
  evidence?: string[];
  checklist?: GoalChecklistItem[];
  facts?: string[];
  assumptions?: string[];
  risks?: string[];
  blockers?: string[];
  nextAction?: string;
  criteria?: { id?: string; text: string; status?: GoalCriterionStatus; evidence?: string }[];
  criterionUpdates?: { id: string; status: GoalCriterionStatus; evidence?: string }[];
  review?: {
    findings: string[];
    evidenceSummary: string;
    unresolvedGaps?: string[];
  };
  completionAssessment?: {
    ready: boolean;
    confidence?: "low" | "medium" | "high";
    reason: string;
    remainingGaps?: string[];
    verificationNeeded?: string[];
  };
  waitCondition?: string;
  resumeTrigger?: string;
  opportunitiesExhausted?: string[];
};

const FALLBACK_DEFAULT_SCAFFOLD: GoalScaffold = {
  id: "default",
  name: "Default",
  description: "Generic coherent progress for ordinary goals.",
  body: "Make one coherent unit of progress per continuation. A coherent unit may be a focused change, bounded investigation, review, or small operating cycle. Update durable goal state and stop.",
  source: "bundled",
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

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) data[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
  }
  return { data, body: raw.slice(end + 5).trim() };
}

async function readScaffoldFile(baseDir: string, id: string, source: GoalScaffold["source"]): Promise<GoalScaffold | undefined> {
  const path = join(baseDir, id, "SCAFFOLD.md");
  if (!existsSync(path)) return undefined;
  const raw = await readFile(path, "utf8");
  const { data, body } = parseFrontmatter(raw);
  return { id: data.name ?? id, name: data.title ?? data.name ?? id, description: data.description ?? "Custom goal scaffold.", body, source, path };
}

async function listScaffoldsFromDir(baseDir: string, source: GoalScaffold["source"]): Promise<GoalScaffold[]> {
  if (!existsSync(baseDir)) return [];
  const scaffolds: GoalScaffold[] = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scaffold = await readScaffoldFile(baseDir, entry.name, source);
    if (scaffold) scaffolds.push(scaffold);
  }
  return scaffolds;
}

async function loadScaffold(cwd: string, id = "default"): Promise<GoalScaffold> {
  const project = await readScaffoldFile(join(cwd, PROJECT_SCAFFOLDS_DIR), id, "project");
  if (project) return project;
  const user = await readScaffoldFile(USER_SCAFFOLDS_DIR, id, "user");
  if (user) return user;
  const bundled = await readScaffoldFile(BUNDLED_SCAFFOLDS_DIR, id, "bundled");
  if (bundled) return bundled;
  return id === "default" ? FALLBACK_DEFAULT_SCAFFOLD : await loadScaffold(cwd, "default");
}

async function listScaffolds(cwd: string): Promise<GoalScaffold[]> {
  const byId = new Map<string, GoalScaffold>();
  for (const [base, source] of [[BUNDLED_SCAFFOLDS_DIR, "bundled"], [USER_SCAFFOLDS_DIR, "user"], [join(cwd, PROJECT_SCAFFOLDS_DIR), "project"]] as const) {
    for (const scaffold of await listScaffoldsFromDir(base, source)) {
      byId.set(scaffold.id, scaffold);
    }
  }
  if (!byId.has("default")) byId.set("default", FALLBACK_DEFAULT_SCAFFOLD);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

function getFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("Goal worker did not return a JSON object.");
}

function parseDelegatedReport(text: string): DelegatedGoalReport {
  const report = JSON.parse(extractJsonObject(text)) as DelegatedGoalReport;
  if (!report || typeof report !== "object") throw new Error("Goal worker report must be an object.");
  if (!["progress", "waiting", "blocked", "ready_to_complete", "no_progress"].includes(report.outcome)) {
    throw new Error(`Invalid goal worker outcome: ${(report as { outcome?: unknown }).outcome}`);
  }
  if (!report.summary?.trim()) throw new Error("Goal worker report requires summary.");
  if (report.outcome !== "ready_to_complete" && report.outcome !== "blocked" && !report.nextAction?.trim()) {
    throw new Error("Goal worker report requires nextAction unless blocked or ready_to_complete.");
  }
  return report;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function checkReportForSecrets(report: DelegatedGoalReport): string | undefined {
  const texts = [
    report.summary,
    report.nextAction,
    report.waitCondition,
    report.resumeTrigger,
    report.completionAssessment?.reason,
    ...(report.actionsTaken ?? []),
    ...(report.evidence ?? []),
    ...(report.facts ?? []),
    ...(report.assumptions ?? []),
    ...(report.risks ?? []),
    ...(report.blockers ?? []),
    ...(report.opportunitiesExhausted ?? []),
    ...(report.completionAssessment?.remainingGaps ?? []),
    ...(report.completionAssessment?.verificationNeeded ?? []),
    ...(report.review?.findings ?? []),
    report.review?.evidenceSummary,
    ...(report.review?.unresolvedGaps ?? []),
    ...(report.checklist ?? []).flatMap((item) => [item.text, item.evidence]),
    ...(report.criteria ?? []).flatMap((item) => [item.id, item.text, item.evidence]),
    ...(report.criterionUpdates ?? []).flatMap((item) => [item.id, item.evidence]),
  ];
  return texts.map((text) => checkNoSecrets(text, "goal worker report")).find(Boolean);
}

function delegatedPrompt(goal: StoredGoal, scaffold: GoalScaffold): string {
  const needsReview = !!goal.reviewEvery && goal.stepCount > 0 && goal.stepCount % goal.reviewEvery === 0 && goal.lastReviewStep !== goal.stepCount;
  return `${needsReview ? "Perform a strategic review for" : "Execute the next delegated continuation for"} this autonomous goal.\n\nOriginal objective:\n<objective>\n${goal.objective}\n</objective>\n\nCurrent durable goal state:\n${renderGoalForModel(goal)}\n\nScaffold: ${scaffold.id} (${scaffold.source})\n${scaffold.body}\n\nTurn contract:\n${needsReview ? "- This is a scheduled strategic review. Do not do broad new execution unless needed to verify state. Review alignment, stale assumptions, evidence quality, blockers, repeated ineffective actions, and the highest-value next focus.\n" : ""}- Spend your context on the actual work for the next step or scaffold-defined operating cycle.\n- Preserve task fidelity by comparing work against the original objective and current durable state.\n- For single-task scaffolds, complete one bounded unit. For operations-style scaffolds, inspect and take all safe, currently available high-value actions until a real wait/resource/uncertainty gate is reached.\n- Do not update goal lifecycle state. The parent owns status, step count, reviews, and completion.\n- If this is complex or long-horizon and no success criteria exist, propose concise criteria in the criteria field before or alongside substantive progress.\n- If you think the goal is done, set outcome to ready_to_complete and include concrete evidence plus verificationNeeded for the parent.\n\nReturn only valid JSON with this shape. Allowed outcome values: progress, waiting, blocked, ready_to_complete, no_progress. Allowed criterion status values: pending, passed, failed. Allowed confidence values: low, medium, high.\n{\n  "outcome": "progress",\n  "summary": "concise current state after your work",\n  "actionsTaken": ["..."],\n  "evidence": ["file paths, command results, produced content, or other concrete evidence"],\n  "checklist": [{ "text": "...", "done": true, "evidence": "..." }],\n  "facts": ["durable facts to retain"],\n  "assumptions": ["assumptions to retain"],\n  "risks": ["risks to retain"],\n  "blockers": ["blockers to retain"],\n  "nextAction": "next concrete action unless blocked or ready_to_complete",\n  "criteria": [{ "id": "optional criterion id", "text": "success criterion", "status": "pending", "evidence": "required when passed" }],\n  "criterionUpdates": [{ "id": "existing criterion id", "status": "passed", "evidence": "required when passed" }],\n  "review": { "findings": ["..."], "evidenceSummary": "...", "unresolvedGaps": ["..."] },\n  "completionAssessment": { "ready": false, "confidence": "medium", "reason": "...", "remainingGaps": ["..."], "verificationNeeded": ["..."] },\n  "waitCondition": "for waiting outcomes",\n  "resumeTrigger": "for waiting outcomes",\n  "opportunitiesExhausted": ["for operations-style cycles"]\n}\n\nOmit optional fields that are not useful. Do not include Markdown. Do not include commentary outside the JSON object.`;
}

async function loadGoalWorkerSystemPrompt(): Promise<string> {
  const raw = await readFile(GOAL_WORKER_AGENT_PATH, "utf8");
  return parseFrontmatter(raw).body;
}

async function runGoalWorker(goal: StoredGoal, scaffold: GoalScaffold, ctx: ExtensionContext): Promise<DelegatedGoalReport> {
  const agentDir = getAgentDir();
  const systemPrompt = await loadGoalWorkerSystemPrompt();
  const loader = new DefaultResourceLoader({
    cwd: goal.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const messages: Message[] = [];
  const { session } = await createAgentSession({
    cwd: goal.cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(goal.cwd),
    model: ctx.model,
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end") messages.push(event.message);
  });

  try {
    await session.prompt(delegatedPrompt(goal, scaffold), { source: "extension" });
    const text = getFinalAssistantText(messages);
    return parseDelegatedReport(text);
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function applyDelegatedReport(goal: StoredGoal, report: DelegatedGoalReport): StoredGoal {
  const secretError = checkReportForSecrets(report);
  if (secretError) throw new Error(`Refusing to store goal worker report: ${secretError}.`);

  const criteria = report.criteria?.length
    ? normalizeCriteriaInputs(report.criteria, goal.criteria ?? []) as GoalCriterion[]
    : report.criterionUpdates?.length
      ? applyCriterionUpdates(goal.criteria ?? [], report.criterionUpdates) as GoalCriterion[]
      : goal.criteria;
  const reviewVerdict: GoalReviewVerdict = report.outcome === "blocked" ? "blocked" : report.outcome === "ready_to_complete" ? "ready_to_complete" : "not_ready";
  const shouldRecordReview = report.outcome === "ready_to_complete" || report.outcome === "blocked" || !!report.review;
  const unresolvedGaps = report.review?.unresolvedGaps
    ?? report.completionAssessment?.remainingGaps
    ?? (report.outcome === "ready_to_complete" ? undefined : [report.nextAction ?? report.waitCondition ?? "Continue delegated goal execution."]);
  const review: GoalReview | undefined = shouldRecordReview ? {
    timestamp: nowIso(),
    verdict: reviewVerdict,
    findings: report.review?.findings?.length ? report.review.findings : [report.completionAssessment?.reason ?? report.summary],
    unresolvedGaps: reviewVerdict === "ready_to_complete" ? undefined : unresolvedGaps,
    evidenceSummary: report.review?.evidenceSummary ?? (report.evidence?.length ? report.evidence.join("; ") : report.summary),
  } : undefined;

  validateReview(review ?? { verdict: "not_ready", findings: ["Delegated progress recorded."], unresolvedGaps: ["Continue."], evidenceSummary: "Delegated progress recorded." });

  const noteParts = [
    `Delegated outcome: ${report.outcome}. ${report.summary}`,
    report.actionsTaken?.length ? `Actions: ${report.actionsTaken.join("; ")}` : undefined,
    report.waitCondition ? `Wait condition: ${report.waitCondition}` : undefined,
    report.resumeTrigger ? `Resume trigger: ${report.resumeTrigger}` : undefined,
  ].filter(Boolean);

  return {
    ...goal,
    status: report.outcome === "blocked" ? "blocked" : goal.status,
    stopReason: report.outcome === "blocked" ? "blocked" : goal.stopReason,
    summary: report.summary,
    checklist: report.checklist ?? goal.checklist,
    criteria,
    reviews: review ? [...(goal.reviews ?? []), review].slice(-20) : goal.reviews,
    lastReviewStep: review ? goal.stepCount : goal.lastReviewStep,
    facts: asStringArray(report.facts) ?? goal.facts,
    assumptions: asStringArray(report.assumptions) ?? goal.assumptions,
    risks: asStringArray(report.risks) ?? goal.risks,
    blockers: report.outcome === "blocked" ? asStringArray(report.blockers) ?? [report.summary] : asStringArray(report.blockers) ?? goal.blockers,
    evidence: asStringArray(report.evidence) ?? goal.evidence,
    nextAction: report.outcome === "ready_to_complete"
      ? "Parent should verify readiness and complete the goal if evidence is sufficient."
      : report.nextAction ?? report.resumeTrigger ?? report.waitCondition ?? goal.nextAction,
    notes: [...goal.notes, { timestamp: nowIso(), text: noteParts.join(" ") }].slice(-50),
    continuationQueued: false,
  };
}

async function runDelegatedContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: StoredGoal): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify(`Running delegated goal step ${goal.stepCount + 1}...`, "info");
  const scaffold = await loadScaffold(ctx.cwd, goal.scaffold ?? "default");
  const report = await runGoalWorker(goal, scaffold, ctx);
  const afterReport = applyDelegatedReport(goal, report);
  const nextStep = goal.stepCount + 1;
  const readiness = report.outcome === "ready_to_complete" ? completionReadiness(afterReport) : { ready: false, missing: [] as string[] };
  const reviewedReport = report.outcome === "ready_to_complete" && !readiness.ready ? {
    ...afterReport,
    reviews: [...(afterReport.reviews ?? []), {
      timestamp: nowIso(),
      verdict: "not_ready" as const,
      findings: ["Parent readiness check rejected delegated completion."],
      unresolvedGaps: readiness.missing,
      evidenceSummary: `Delegated worker proposed completion, but readiness gaps remain: ${readiness.missing.join("; ")}`,
    }].slice(-20),
    nextAction: `Address parent readiness gaps: ${readiness.missing.join("; ")}`,
  } : afterReport;
  const reachedCap = reviewedReport.maxIterations !== undefined && nextStep >= reviewedReport.maxIterations;
  const completed = report.outcome === "ready_to_complete" && readiness.ready;
  const updated = await writeGoal({
    ...reviewedReport,
    status: completed ? "complete" : reachedCap && reviewedReport.status === "active" ? "paused" : reviewedReport.status,
    stopReason: completed ? reviewedReport.stopReason : reachedCap && reviewedReport.status === "active" ? "maxIterationsReached" : reviewedReport.stopReason,
    stepCount: nextStep,
    continuationQueued: false,
  });
  updateStatus(ctx, updated);

  const message = completed
    ? `Goal completed by delegated worker after parent readiness check.\n\n${report.summary}`
    : report.outcome === "ready_to_complete"
      ? `Delegated worker thinks goal may be complete, but parent readiness check found gaps:\n${readiness.missing.map((item) => `- ${item}`).join("\n")}`
      : `Delegated goal step ${nextStep}: ${report.outcome}\n${report.summary}`;
  pi.sendMessage({ customType: "goal-delegated-step", content: message, display: true, details: { report, goal: goalForModel(updated), path: goalPath(updated.id) } });

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
      await runDelegatedContinuation(pi, ctx, goal);
    } catch (error) {
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

      if (subcommand === "scaffolds") {
        const scaffolds = await listScaffolds(ctx.cwd);
        ctx.ui.notify(scaffolds.map((item) => `${item.id} (${item.source}) — ${item.description}`).join("\n"), "info");
        return;
      }

      if (subcommand === "scaffold") {
        const value = trimmed.slice("scaffold".length).trim();
        const current = await reloadRuntime(ctx);
        if (!current) {
          ctx.ui.notify("No current goal found.", "warning");
          return;
        }
        if (!value || value === "status") {
          const scaffold = await loadScaffold(ctx.cwd, current.scaffold ?? "default");
          ctx.ui.notify(`Current scaffold: ${scaffold.id} (${scaffold.source})\n${scaffold.description}`, "info");
          return;
        }
        const scaffold = await loadScaffold(ctx.cwd, value);
        if (scaffold.source === "bundled" && scaffold.id === "default" && value !== "default") {
          ctx.ui.notify(`Scaffold not found: ${value}`, "warning");
          return;
        }
        const goal = await mutateCurrentGoal(ctx.cwd, (current) => ({ ...current, scaffold: value, continuationQueued: false }));
        updateStatus(ctx, goal);
        ctx.ui.notify(`Goal scaffold set to ${scaffold.id} (${scaffold.source}).`, "info");
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
        continuationQueued: false,
      }));
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

  pi.on("agent_end", async (_event, ctx) => {
    const goal = await readCurrentGoal(ctx.cwd);
    runtime = goal;
    updateStatus(ctx, goal);
    if (goal?.status === "active") queueContinuation(pi, ctx, goal);
  });
}
