import assert from "node:assert/strict";
import test from "node:test";
import { queueContinuation } from "../goal-continuation.ts";
import type { StoredGoal } from "../goal-types.ts";

function activeGoal(): StoredGoal {
  return { version: 1, id: "goal", cwd: "/tmp/project", status: "active", objective: "Test", createdAt: "now", updatedAt: "now", stepCount: 0, summary: "", checklist: [], nextAction: "work", notes: [] };
}

function harness(goal: StoredGoal) {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const notifications: string[] = [];
  let runtime: StoredGoal | undefined;
  let pending = true;
  let runs = 0;
  const ctx = {
    cwd: goal.cwd,
    hasPendingMessages: () => pending,
    isIdle: () => true,
    ui: { setStatus() {}, notify: (message: string) => notifications.push(message) },
  } as any;
  const services = {
    isShuttingDown: () => false,
    getRuntime: () => runtime,
    setRuntime: (next: StoredGoal) => { runtime = next; },
    updateStatus() {},
    readCurrentGoal: async () => goal,
    runDelegatedContinuation: async () => { runs += 1; },
    isNonRetryableContinuationError: () => false,
    nowMs: () => 42,
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); },
  };
  queueContinuation({} as any, ctx, goal, services);
  return { timers, notifications, services, setPending: (value: boolean) => { pending = value; }, runs: () => runs };
}

test("queue continuation preserves busy retry delays before running", async () => {
  const goal = activeGoal();
  const retryState = harness(goal);
  assert.equal(goal.lastContinuationAt, 42);
  const initial = retryState.timers.shift()!;
  assert.equal(initial.delay, 0);
  await initial.callback();
  assert.equal(retryState.timers[0].delay, 100);
  retryState.setPending(false);
  await retryState.timers.shift()!.callback();
  assert.equal(retryState.runs(), 1);
});

test("queue continuation stops immediately for nonretryable failures", async () => {
  const goal = activeGoal();
  const state = harness(goal);
  state.services.runDelegatedContinuation = async () => { throw new Error("invalid report"); };
  state.services.isNonRetryableContinuationError = () => true;
  state.setPending(false);
  await state.timers.shift()!.callback();
  assert.equal(goal.continuationQueued, false);
  assert.deepEqual(state.notifications, ["Delegated continuation stopped without retry: invalid report"]);
  assert.equal(state.timers.length, 0);
});

test("queue continuation reports retry exhaustion", async () => {
  const goal = activeGoal();
  const state = harness(goal);
  let attempts = 0;
  const delays: number[] = [];
  state.services.runDelegatedContinuation = async () => {
    attempts += 1;
    throw new Error("still failing");
  };
  state.setPending(false);

  while (state.timers.length) {
    const timer = state.timers.shift()!;
    delays.push(timer.delay);
    await timer.callback();
  }

  assert.equal(attempts, 6);
  assert.deepEqual(delays, [0, 100, 250, 500, 1000, 2000]);
  assert.deepEqual(state.notifications, ["Failed to run delegated goal continuation after retries: still failing"]);
});
