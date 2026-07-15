import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evidence = (kind = "test", ref = "integration") => ({ kind, ref, status: "passed", summary: "Integration proof." });

function report(role, outcome = "progress", overrides = {}) {
  return {
    schemaVersion: 1,
    role,
    outcome,
    summary: `${role} ${outcome}`,
    confidence: "high",
    actions: [{ summary: `${role} action`, evidence: [evidence("observation", `${role}-action`)] }],
    evidence: [evidence("observation", `${role}-evidence`)],
    nextAction: "Continue the goal.",
    ...overrides,
  };
}

function context(cwd) {
  return {
    cwd,
    hasUI: false,
    model: undefined,
    ui: { notify() {}, setStatus() {} },
    hasPendingMessages: () => false,
    isIdle: () => true,
  };
}

function api() {
  const messages = [];
  return { messages, sendMessage(message) { messages.push(message); } };
}

function memoryDeps(reports, { now = "2026-01-01T00:00:00.000Z" } = {}) {
  const writes = [];
  const prompts = [];
  const runOptions = [];
  let index = 0;
  return {
    writes,
    prompts,
    runOptions,
    deps: {
      now: () => now,
      runAgent: async (options) => {
        prompts.push(options.prompt);
        runOptions.push(options);
        const next = reports[index++];
        if (next instanceof Error) {
          next.sessionFile = `fake-session-${index}.json`;
          throw next;
        }
        return { exitCode: 0, finalText: JSON.stringify(next), sessionFile: `fake-session-${index}.json` };
      },
      writeGoal: async (goal) => {
        const saved = { ...goal, updatedAt: now };
        writes.push(saved);
        return saved;
      },
    },
  };
}

const testHome = await mkdtemp(join(tmpdir(), "goal-integration-home-"));
process.env.HOME = testHome;
const { default: goalExtension, runDelegatedContinuation } = await import("../goal.ts");

async function seedCurrentGoal(cwd, goal) {
  const store = join(testHome, ".pi", "agent", "goals");
  await mkdir(join(store, "goals"), { recursive: true });
  await writeFile(join(store, "index.json"), JSON.stringify({ version: 1, byCwd: { [cwd]: goal.id } }));
  await writeFile(join(store, "goals", `${goal.id}.json`), JSON.stringify(goal));
}

function registeredExtension() {
  const tools = new Map();
  const commands = new Map();
  const entries = new Map();
  const appendedEntries = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerEntryRenderer(name, renderer) { entries.set(name, renderer); },
    appendEntry(type, data) { appendedEntries.push({ type, data }); },
    on() {},
  };
  goalExtension(pi);
  return { tools, commands, entries, appendedEntries };
}

test("worker continuation persists checkpoints, iteration, and session reference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-"));
  const { deps, writes, prompts, runOptions } = memoryDeps([report("worker")]);
  const pi = api();
  await runDelegatedContinuation(pi, context(cwd), {
    id: "goal-worker",
    version: 1,
    cwd,
    status: "active",
    objective: "Make progress",
    scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 0,
    maxIterations: 1,
    summary: "Start",
    checklist: [],
    criteria: [],
    reviews: [],
    nextAction: "Work",
    notes: [],
  }, deps);

  const saved = writes.at(-1);
  assert.equal(saved.status, "paused");
  assert.equal(saved.stepCount, 1);
  assert.equal(saved.roleCheckpoints.at(-1).role, "worker");
  assert.equal(saved.roleCheckpoints.at(-1).status, "completed");
  assert.equal(saved.roleCheckpoints.at(-1).sessionFile, "fake-session-1.json");
  assert.deepEqual(saved.iterations.at(-1).sessionRefs[0].sessionFile, "fake-session-1.json");
  assert.match(pi.messages.at(-1).content, /Delegated goal step 1/);
  assert.match(prompts[0], /reportContractHint/);
  assert.doesNotMatch(prompts[0], /Human-readable goal snapshot/);
  assert.doesNotMatch(prompts[0], /"outcome": "progress"/);
  assert.ok(runOptions[0].tools.includes("bash"));
  assert.ok(!runOptions[0].tools.includes("bash_read_only"));
  assert.equal(runOptions[0].inlineExtensions, undefined);
});

test("observer report is checkpointed and handed to the worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-observer-"));
  await mkdir(join(cwd, ".pi", "scaffolds", "observer-case"), { recursive: true });
  await writeFile(join(cwd, ".pi", "scaffolds", "observer-case", "SCAFFOLD.md"), `---\nname: observer-case\nworkflow: observer-worker\nblockedPolicy: external-blocker-only\n---\nObserve, then work.\n`);
  const observer = report("observer", "progress", { nextAction: "Worker should use the observation." });
  const worker = report("worker");
  const { deps, writes, prompts, runOptions } = memoryDeps([observer, worker]);
  await runDelegatedContinuation(api(), context(cwd), {
    id: "goal-observer",
    version: 1,
    cwd,
    status: "active",
    objective: "Observe and act",
    scaffold: "observer-case",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 0,
    maxIterations: 1,
    summary: "Start",
    checklist: [],
    criteria: [],
    reviews: [],
    nextAction: "Inspect",
    notes: [],
  }, deps);

  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].roleCheckpoints.at(-1).role, "observer");
  assert.deepEqual(writes[1].roleCheckpoints.map((item) => item.role), ["observer", "worker"]);
  assert.match(prompts[1], /Worker should use the observation/);
  assert.deepEqual(writes.at(-1).iterations.at(-1).roles, ["observer", "worker"]);
  assert.ok(runOptions[0].tools.includes("bash_read_only"));
  assert.ok(!runOptions[0].tools.includes("bash"));
  assert.equal(runOptions[0].inlineExtensions?.[0]?.name, "goal-bash-read-only");
  assert.ok(runOptions[1].tools.includes("bash"));
  assert.equal(runOptions[1].inlineExtensions, undefined);
});

test("worker readiness advances a reviewed phase without completing the goal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-phase-"));
  const worker = report("worker", "ready_for_review", { nextAction: undefined });
  const reviewer = report("reviewer", "review_complete", {
    verdict: "ready_to_complete",
    findings: ["Planning phase is complete."],
    criteriaAssessment: [{ id: "CRIT-PLAN", status: "proven", reason: "Plan verified.", evidence: [evidence("test", "plan")] }],
    phaseTransition: { toPhaseId: "execute", evidence: [evidence("observation", "phase transition")] },
    nextAction: undefined,
  });
  const { deps, writes } = memoryDeps([worker, reviewer]);
  await runDelegatedContinuation(api(), context(cwd), {
    id: "goal-phase",
    version: 1,
    cwd,
    status: "active",
    objective: "Plan then execute",
    scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 0,
    maxIterations: 1,
    summary: "Start",
    checklist: [],
    criteria: [{ id: "CRIT-PLAN", text: "Plan is ready", status: "passed", evidence: "plan proof" }, { id: "CRIT-EXEC", text: "Execution is ready", status: "pending" }],
    phases: [
      { id: "plan", title: "Plan", objective: "Plan", status: "active", criterionIds: ["CRIT-PLAN"] },
      { id: "execute", title: "Execute", objective: "Execute", status: "pending", criterionIds: ["CRIT-EXEC"] },
    ],
    currentPhaseId: "plan",
    reviews: [],
    nextAction: "Plan",
    notes: [],
  }, deps);

  const saved = writes.at(-1);
  assert.equal(saved.status, "paused");
  assert.equal(saved.currentPhaseId, "execute");
  assert.deepEqual(saved.phases.map((phase) => phase.status), ["passed", "active"]);
  assert.equal(saved.reviews.at(-1).kind, "phase_gate");
});

test("worker readiness requires a parent review before completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-review-"));
  const worker = report("worker", "ready_for_review", { nextAction: undefined });
  const reviewer = report("reviewer", "review_complete", {
    verdict: "ready_to_complete",
    findings: ["All evidence is sufficient."],
    criteriaAssessment: [{ id: "CRIT-001", status: "proven", reason: "Verified.", evidence: [evidence("test", "criterion")] }],
    nextAction: undefined,
  });
  const { deps, writes } = memoryDeps([worker, reviewer]);
  await runDelegatedContinuation(api(), context(cwd), {
    id: "goal-review",
    version: 1,
    cwd,
    status: "active",
    objective: "Finish verified work",
    scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 0,
    maxIterations: 3,
    summary: "Start",
    checklist: [],
    criteria: [{ id: "CRIT-001", text: "Verified", status: "pending" }],
    reviews: [],
    nextAction: "Work",
    notes: [],
  }, deps);

  const saved = writes.at(-1);
  assert.equal(saved.status, "complete");
  assert.deepEqual(saved.roleCheckpoints.map((item) => item.role), ["worker", "reviewer"]);
  assert.equal(saved.reviews.at(-1).verdict, "ready_to_complete");
});

test("failed worker execution preserves a failed checkpoint and session reference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-failure-"));
  const failure = new Error("synthetic worker failure");
  const { deps, writes } = memoryDeps([failure]);

  await assert.rejects(() => runDelegatedContinuation(api(), context(cwd), {
    id: "goal-failure",
    version: 1,
    cwd,
    status: "active",
    objective: "Fail safely",
    scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 0,
    maxIterations: 1,
    summary: "Start",
    checklist: [],
    criteria: [],
    reviews: [],
    nextAction: "Work",
    notes: [],
  }, deps), /synthetic worker failure/);

  const saved = writes.at(-1);
  assert.equal(saved.roleCheckpoints.at(-1).role, "worker");
  assert.equal(saved.roleCheckpoints.at(-1).status, "failed");
  assert.equal(saved.roleCheckpoints.at(-1).sessionFile, "fake-session-1.json");
});

test("goal_phases stores ordered phases and current phase", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-phases-tool-"));
  const goal = {
    id: "phases-tool",
    version: 1,
    cwd,
    status: "active",
    objective: "Plan and execute",
    stepCount: 0,
    summary: "Start",
    checklist: [],
    criteria: [],
    reviews: [],
    notes: [],
    nextAction: "Plan",
  };
  await seedCurrentGoal(cwd, goal);
  const extension = registeredExtension();
  const result = await extension.tools.get("goal_phases").execute("phases-tool", {
    phases: [
      { id: "plan", title: "Plan", objective: "Prepare", criterionIds: [] },
      { id: "execute", title: "Execute", objective: "Act", criterionIds: [] },
    ],
  }, undefined, undefined, context(cwd));
  assert.equal(result.details.goal.currentPhaseId, "plan");
  assert.deepEqual(result.details.goal.phases.map((phase) => phase.status), ["active", "pending"]);
});

test("get_goal returns active state but suppresses terminal history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-lookup-"));
  const active = {
    id: "lookup-active",
    version: 1,
    cwd,
    status: "active",
    objective: "Current objective",
    stepCount: 2,
    summary: "Current summary",
    checklist: [],
    criteria: [],
    reviews: [],
    notes: [],
    nextAction: "Continue",
  };
  await seedCurrentGoal(cwd, active);
  const extension = registeredExtension();
  const getGoal = extension.tools.get("get_goal");
  await extension.commands.get("goal").handler("status", context(cwd));
  assert.deepEqual(extension.appendedEntries[0], { type: "goal-command", data: { text: "/goal status" } });
  assert.equal(extension.entries.get("goal-command")({ data: { text: "/goal status" } }).text, "/goal status");
  const activeResult = await getGoal.execute("lookup-active", {}, undefined, undefined, {
    cwd,
    hasUI: false,
    ui: { setStatus() {} },
  });
  assert.equal(activeResult.details.active, true);
  assert.match(activeResult.content[0].text, /Current objective/);

  const complete = { ...active, id: "lookup-complete", status: "complete", updatedAt: "2026-01-01T00:00:00.000Z" };
  await seedCurrentGoal(cwd, complete);
  const terminalResult = await getGoal.execute("lookup-complete", {}, undefined, undefined, {
    cwd,
    hasUI: false,
    ui: { setStatus() {} },
  });
  assert.equal(terminalResult.details.active, false);
  assert.equal(terminalResult.details.terminal, true);
  assert.match(terminalResult.content[0].text, /^NO_ACTIVE_GOAL/);
  assert.doesNotMatch(terminalResult.content[0].text, /Current objective/);
});

test("scheduled strategic review is recorded without completing the goal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-integration-strategic-"));
  const strategic = report("reviewer", "review_complete", {
    verdict: "ready_to_complete",
    findings: ["A terminal review may be warranted."],
    criteriaAssessment: [],
    nextAction: "Continue with terminal verification.",
  });
  const { deps, writes } = memoryDeps([strategic]);
  await runDelegatedContinuation(api(), context(cwd), {
    id: "goal-strategic",
    version: 1,
    cwd,
    status: "active",
    objective: "Review strategy",
    scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount: 5,
    maxIterations: 6,
    reviewEvery: 5,
    summary: "Start",
    checklist: [],
    criteria: [],
    reviews: [],
    nextAction: "Review",
    notes: [],
  }, deps);

  const saved = writes.at(-1);
  assert.equal(saved.status, "paused");
  assert.equal(saved.reviews.at(-1).kind, "strategic");
  assert.equal(saved.reviews.at(-1).verdict, "ready_to_complete");
  assert.equal(saved.iterations.at(-1).roles[0], "reviewer");
});
