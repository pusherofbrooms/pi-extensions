import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand, type GoalCommandServices } from "../goal-command.ts";
import { createStoredGoal } from "../goal-factory.ts";
import type { GoalScaffold, StoredGoal } from "../goal-types.ts";

const defaultScaffold: GoalScaffold = {
  id: "default", name: "Default", source: "bundled", description: "Default scaffold", body: "", policy: { reviewEvery: 4 },
};
const unsafeIntegerDigits = "9".repeat(100);

type HarnessOptions = {
  current?: StoredGoal;
  scaffolds?: GoalScaffold[];
  loadedScaffold?: GoalScaffold;
  secretError?: (value: string | undefined, label: string) => string | undefined;
};

function setup(options: HarnessOptions = {}) {
  type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;
  let handler: Handler = async () => {};
  let renderer: ((entry: { data: unknown }) => unknown) | undefined;
  const events: string[] = [];
  const calls = { checks: [] as [string | undefined, string][], loads: [] as [string, string | undefined][], lists: [] as string[] };
  let goal = options.current;
  const pi = {
    appendEntry: (_type: string, data: { text: string }) => events.push(`entry:${data.text}`),
    registerCommand: (_name: string, command: { handler: Handler }) => { handler = command.handler; },
    registerEntryRenderer: (_name: string, value: typeof renderer) => { renderer = value; },
  } as unknown as ExtensionAPI;
  const services: GoalCommandServices = {
    checkNoSecrets: (value, label) => {
      calls.checks.push([value, label]);
      return options.secretError?.(value, label);
    },
    goalPath: (id) => `/goals/${id}.json`,
    goalSummary: (value) => `summary:${value.status}`,
    listScaffolds: async (cwd) => { calls.lists.push(cwd); return options.scaffolds ?? []; },
    loadScaffold: async (cwd, id) => { calls.loads.push([cwd, id]); return options.loadedScaffold ?? defaultScaffold; },
    makeId: () => "goal-id",
    mutateCurrentGoal: async (cwd, mutate) => {
      events.push(`mutate:${cwd}`);
      if (!goal) return undefined;
      goal = mutate(goal);
      events.push(`persist:${goal.status}:${goal.maxIterations ?? "none"}`);
      return goal;
    },
    now: () => "2026-01-01T00:00:00.000Z",
    queueContinuation: (_pi, _ctx, value) => events.push(`queue:${value.status}:${value.maxIterations ?? "none"}`),
    reloadRuntime: async (ctx) => { events.push(`reload:${ctx.cwd}`); return goal; },
    updateStatus: (_ctx, value) => events.push(`status:${value?.status ?? "none"}`),
    writeGoal: async (value) => {
      goal = value;
      events.push(`persist:${value.status}:${value.maxIterations ?? "none"}`);
      return value;
    },
  };
  const ctx = {
    cwd: "/project",
    sessionManager: { getSessionFile: () => "/session.jsonl" },
    ui: { notify: (message: string, level: string) => events.push(`notify:${level}:${message}`) },
  } as unknown as ExtensionContext;
  registerGoalCommand(pi, services);
  return {
    calls, events, getGoal: () => goal,
    render: (data: unknown) => renderer?.({ data }),
    run: (args: string) => handler(args, ctx),
  };
}

function storedGoal(overrides: Partial<StoredGoal> = {}): StoredGoal {
  return { ...createStoredGoal({
    id: "existing", cwd: "/project", objective: "Objective", scaffold: "default",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    noteTimestamp: "2026-01-01T00:00:00.000Z", noteText: "created",
  }), ...overrides };
}

for (const command of ["", "status"]) {
  test(`/goal ${command || "<empty>"} reports status`, async () => {
    const harness = setup({ current: storedGoal() });
    await harness.run(command);
    assert.deepEqual(harness.events.slice(-2), ["reload:/project", "notify:info:summary:active"]);
  });
}

test("status reports a missing goal and the command renderer preserves text", async () => {
  const harness = setup();
  await harness.run("status");
  assert.match(harness.events.at(-1) ?? "", /notify:warning:No current goal/);
  assert.equal((harness.render({ text: "/goal status" }) as { text?: string }).text, "/goal status");
  assert.equal((harness.render(null) as { text?: string }).text, "");
});

for (const alias of ["help", "--help", "-h"]) {
  test(`/goal ${alias} shows help`, async () => {
    const harness = setup();
    await harness.run(alias);
    assert.match(harness.events.at(-1) ?? "", /notify:info:Goal commands:/);
  });
}

test("scaffolds lists policy-bearing entries", async () => {
  const scaffold = { ...defaultScaffold, id: "strict", source: "project" as const, description: "Strict" };
  const harness = setup({ scaffolds: [scaffold] });
  await harness.run("scaffolds");
  assert.deepEqual(harness.calls.lists, ["/project"]);
  assert.match(harness.events.at(-1) ?? "", /strict \(project\).*Strict/s);
});

for (const command of ["scaffold", "scaffold status"]) {
  test(`${command} shows the selected scaffold`, async () => {
    const harness = setup({ current: storedGoal(), loadedScaffold: { ...defaultScaffold, id: "strict", source: "project" } });
    await harness.run(command);
    assert.deepEqual(harness.calls.loads, [["/project", "default"]]);
    assert.match(harness.events.at(-1) ?? "", /Current scaffold: strict \(project\)/);
  });
}

test("scaffold selection persists the requested id", async () => {
  const harness = setup({ current: storedGoal(), loadedScaffold: { ...defaultScaffold, id: "strict", source: "project" } });
  await harness.run("scaffold strict");
  assert.equal(harness.getGoal()?.scaffold, "strict");
  assert.deepEqual(harness.calls.loads, [["/project", "strict"]]);
  assert.deepEqual(harness.events.slice(-3), ["persist:active:none", "status:active", "notify:info:Goal scaffold set to strict (project)."]);
});

test("scaffold handles missing goals and unknown fallback scaffolds", async () => {
  const missing = setup();
  await missing.run("scaffold strict");
  assert.match(missing.events.at(-1) ?? "", /warning:No current goal/);
  const unknown = setup({ current: storedGoal() });
  await unknown.run("scaffold typo");
  assert.match(unknown.events.at(-1) ?? "", /warning:Scaffold not found: typo/);
  assert.equal(unknown.events.some((event) => event.startsWith("mutate:")), false);
});

for (const [command, status, reason] of [
  ["pause", "paused", "pausedByUser"], ["clear", "cleared", "clearedByUser"], ["complete", "complete", undefined],
] as const) {
  test(`/goal ${command} changes state`, async () => {
    const harness = setup({ current: storedGoal() });
    await harness.run(command);
    assert.equal(harness.getGoal()?.status, status);
    assert.equal(harness.getGoal()?.stopReason, reason);
    assert.deepEqual(harness.events.slice(-3), [`persist:${status}:none`, `status:${status}`, `notify:info:Goal marked ${status}.`]);
  });
}

for (const command of ["pause", "clear", "complete"]) {
  test(`${command} reports a missing goal`, async () => {
    const harness = setup();
    await harness.run(command);
    assert.deepEqual(harness.events.slice(-2), ["status:none", "notify:warning:No current goal found."]);
  });
}

test("resume persists and updates UI before queueing", async () => {
  const harness = setup({ current: storedGoal({ status: "paused", stopReason: "pausedByUser" }) });
  await harness.run("resume");
  assert.deepEqual(harness.events.slice(-4), ["persist:active:none", "status:active", "notify:info:Goal resumed; queuing continuation.", "queue:active:none"]);
  assert.equal(harness.getGoal()?.stopReason, undefined);
});

test("resume without a goal does not update or queue", async () => {
  const harness = setup();
  await harness.run("resume");
  assert.match(harness.events.at(-1) ?? "", /warning:No current goal found to resume/);
  assert.equal(harness.events.some((event) => event.startsWith("queue:")), false);
});

for (const command of ["max 7", "max none", "review-every 3", "review-every none"]) {
  test(`/goal ${command} sets or clears its value`, async () => {
    const harness = setup({ current: storedGoal({ maxIterations: 2, reviewEvery: 2 }) });
    await harness.run(command);
    const goal = harness.getGoal();
    if (command.startsWith("max")) assert.equal(goal?.maxIterations, command.endsWith("none") ? undefined : 7);
    else assert.equal(goal?.reviewEvery, command.endsWith("none") ? undefined : 3);
    assert.ok(harness.events.includes("status:active"));
  });
}

for (const command of [
  "max", "max 0", "max -1", "max 7abc", `max ${unsafeIntegerDigits}`,
  "review-every", "review-every 0", "review-every -1", "review-every 3junk", `review-every ${unsafeIntegerDigits}`,
]) {
  test(`/goal ${command} rejects invalid values`, async () => {
    const initial = storedGoal({ maxIterations: 2, reviewEvery: 2 });
    const harness = setup({ current: initial });
    await harness.run(command);
    assert.equal(harness.getGoal(), initial);
    assert.match(harness.events.at(-1) ?? "", /notify:warning:Usage:/);
  });
}

for (const alias of ["more", "--more"]) {
  test(`/goal ${alias} extends and resumes a cap-paused goal`, async () => {
    const harness = setup({ current: storedGoal({ status: "paused", stopReason: "maxIterationsReached", stepCount: 3, maxIterations: 3 }) });
    await harness.run(`${alias} 2`);
    assert.equal(harness.getGoal()?.maxIterations, 5);
    assert.deepEqual(harness.events.slice(-4), ["persist:active:5", "status:active", "notify:info:Goal max iterations extended to 5.", "queue:active:5"]);
  });
}

for (const command of ["more", "more 0", "more nope", "more 3junk", "--more -2", `--more ${unsafeIntegerDigits}`]) {
  test(`/goal ${command} rejects invalid extension`, async () => {
    const harness = setup({ current: storedGoal() });
    await harness.run(command);
    assert.match(harness.events.at(-1) ?? "", /warning:Usage: \/goal more/);
  });
}

test("more does not queue a non-active goal or mutate when no goal exists", async () => {
  const blocked = setup({ current: storedGoal({ status: "blocked" }) });
  await blocked.run("more 2");
  assert.equal(blocked.events.some((event) => event.startsWith("queue:")), false);
  const missing = setup();
  await missing.run("more 2");
  assert.match(missing.events.at(-1) ?? "", /warning:No current goal/);
});

test("creation passes parsed values to persistence and preserves event ordering", async () => {
  const harness = setup();
  await harness.run("--max 3 Ship the feature");
  assert.equal(harness.getGoal()?.objective, "Ship the feature");
  assert.equal(harness.getGoal()?.sessionFile, "/session.jsonl");
  assert.equal(harness.getGoal()?.reviewEvery, 4);
  assert.deepEqual(harness.calls.loads, [["/project", "default"]]);
  assert.deepEqual(harness.events.slice(-4), ["persist:active:3", "status:active", "notify:info:Goal started. State: /goals/goal-id.json", "queue:active:3"]);
});

for (const command of [
  "--max", "--max 3", "--max nope Objective", "--max 0 Objective", "--max -1 Objective",
  "--max 7abc Objective", `--max ${unsafeIntegerDigits} Objective`,
]) {
  test(`creation rejects malformed cap: ${command}`, async () => {
    const harness = setup();
    await harness.run(command);
    assert.equal(harness.getGoal(), undefined);
    assert.match(harness.events.at(-1) ?? "", /notify:warning:Usage: \/goal --max/);
  });
}

test("creation rejects empty and oversized objectives", async () => {
  const empty = setup();
  await empty.run("   ");
  assert.equal(empty.getGoal(), undefined);
  const oversized = setup();
  await oversized.run("x".repeat(4001));
  assert.match(oversized.events.at(-1) ?? "", /too long \(4001\/4000 chars\)/);
});

test("secret-bearing commands are suppressed from history and objectives are rejected", async () => {
  const harness = setup({ secretError: (value, label) => value?.includes("SECRET") ? `${label} contains a secret` : undefined });
  await harness.run("Ship SECRET safely");
  assert.equal(harness.events.some((event) => event.startsWith("entry:")), false);
  assert.equal(harness.getGoal(), undefined);
  assert.match(harness.events.at(-1) ?? "", /Refusing to store goal objective: Goal objective contains a secret/);
  assert.deepEqual(harness.calls.checks, [["/goal Ship SECRET safely", "Goal command"], ["Ship SECRET safely", "Goal objective"]]);
});
