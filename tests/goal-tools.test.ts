import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalTools, type GoalToolServices } from "../goal-tools.ts";
import { createStoredGoal } from "../goal-factory.ts";
import type { GoalScaffold, StoredGoal } from "../goal-types.ts";

const scaffold: GoalScaffold = { id: "default", name: "Default", source: "bundled", description: "Default", body: "", policy: { reviewEvery: 4 } };

function setup(current?: StoredGoal, secret?: string, readSessionFile: (path: string) => Promise<string> = async () => "session") {
  const tools = new Map<string, any>();
  const events: string[] = [];
  let goal = current;
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  const services: GoalToolServices = {
    checkNoSecrets: () => secret,
    goalForModel: (value) => value,
    goalPath: (id) => `/goals/${id}.json`,
    listScaffolds: async () => [scaffold],
    loadScaffold: async () => scaffold,
    makeId: () => "new-id",
    mutateCurrentGoal: async (_cwd, mutate) => {
      events.push("mutate");
      if (!goal) return undefined;
      goal = mutate(goal);
      events.push("persist");
      return goal;
    },
    now: () => "2026-01-01T00:00:00.000Z",
    queueContinuation: () => events.push("queue"),
    readCurrentGoal: async () => goal,
    readSessionFile,
    reloadRuntime: async () => goal,
    renderGoalForModel: () => "rendered",
    updateStatus: () => events.push("status"),
    writeGoal: async (value) => { events.push("persist"); goal = value; return value; },
  };
  registerGoalTools(pi, services);
  const ctx = { cwd: "/project", sessionManager: { getSessionFile: () => "/session" } } as ExtensionContext;
  const execute = (name: string, params: unknown = {}) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  return { events, execute, tools, getGoal: () => goal };
}

function storedGoal(overrides: Partial<StoredGoal> = {}): StoredGoal {
  return { ...createStoredGoal({ id: "existing", cwd: "/project", objective: "Objective", scaffold: "default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", noteTimestamp: "2026-01-01T00:00:00.000Z", noteText: "created" }), ...overrides };
}

test("preserves the model-facing goal tool contract", () => {
  const { tools } = setup();
  const actual = JSON.parse(JSON.stringify([...tools.values()].map(
    ({ name, label, description, promptSnippet, promptGuidelines, parameters }) =>
      ({ name, label, description, promptSnippet, promptGuidelines, parameters }))));
  const expected = JSON.parse(readFileSync(new URL("./fixtures-goal-tool-contracts.json", import.meta.url), "utf8"));
  assert.deepEqual(actual, expected);
});

test("goal_inspect_session uses the injected reader and truncates the latest referenced session", async () => {
  const paths: string[] = [];
  const goal = storedGoal({
    iterations: [{
      step: 1, timestamp: "2026-01-01T00:00:00.000Z", roles: ["worker"], outcome: "progress",
      summary: "worked", evidence: [], nextAction: "continue",
      sessionRefs: [
        { role: "worker", timestamp: "2026-01-01T00:00:00.000Z", sessionFile: "/sessions/old.jsonl" },
        { role: "reviewer", timestamp: "2026-01-01T00:01:00.000Z", sessionFile: "/sessions/latest.jsonl" },
      ],
    }],
  });
  const harness = setup(goal, undefined, async (path) => { paths.push(path); return `prefix-${"x".repeat(1500)}`; });

  const result = await harness.execute("goal_inspect_session", { maxChars: 1200 });

  assert.deepEqual(paths, ["/sessions/latest.jsonl"]);
  assert.equal(result.content[0].text, "x".repeat(1200));
  assert.deepEqual({ truncated: result.details.truncated, returnedChars: result.details.returnedChars, totalChars: result.details.totalChars },
    { truncated: true, returnedChars: 1200, totalChars: 1507 });
});

test("goal_start requires approval without persistence or queueing", async () => {
  const harness = setup();
  const result = await harness.execute("goal_start", { objective: "Do work", approved: false });
  assert.equal(result.details.approvalRequired, true);
  assert.deepEqual(harness.events, []);
});

test("goal_start persists and updates status before queueing", async () => {
  const harness = setup();
  await harness.execute("goal_start", { objective: "Do work", approved: true });
  assert.deepEqual(harness.events, ["persist", "status", "queue"]);
  assert.equal(harness.getGoal()?.id, "new-id");
});

test("secret validation prevents goal_note mutation", async () => {
  const harness = setup(storedGoal(), "note contains a secret");
  await assert.rejects(harness.execute("goal_note", { note: "unsafe" }), /Refusing to store goal note/);
  assert.deepEqual(harness.events, []);
});

test("update_goal reports readiness failures without mutation", async () => {
  const harness = setup(storedGoal());
  const result = await harness.execute("update_goal", { status: "complete" });
  assert.equal(result.details.updated, false);
  assert.ok(result.details.missing.length > 0);
  assert.deepEqual(harness.events, []);
});
