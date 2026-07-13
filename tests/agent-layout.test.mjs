import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("internal goal roles are segregated from generic subagent discovery", async () => {
  const genericAgents = await readdir(join(root, "agents"));
  const goalAgents = await readdir(join(root, "goal-agents"));

  assert.deepEqual(genericAgents.sort(), ["planner.md", "reviewer.md", "scout.md", "worker.md"]);
  assert.deepEqual(goalAgents.sort(), [
    "goal-observer.md",
    "goal-parent-reviewer.md",
    "goal-researcher.md",
    "goal-worker.md",
  ]);
});
