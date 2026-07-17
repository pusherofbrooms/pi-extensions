import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson, withPersistenceLock } from "../goal-persistence.mjs";

test("atomicWriteJson replaces JSON without leaving temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-persistence-"));
  const path = join(dir, "goal.json");
  try {
    await atomicWriteJson(path, { revision: 1 });
    await atomicWriteJson(path, { revision: 2 });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { revision: 2 });
    assert.deepEqual(await readdir(dir), ["goal.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withPersistenceLock serializes read-modify-write operations by key", async () => {
  let value = 0;
  const updates = Array.from({ length: 20 }, () => withPersistenceLock("same-goal", async () => {
    const previous = value;
    await new Promise((resolve) => setTimeout(resolve, 1));
    value = previous + 1;
  }));
  await Promise.all(updates);
  assert.equal(value, 20);
});

test("withPersistenceLock releases the queue after an operation fails", async () => {
  await assert.rejects(withPersistenceLock("failure", async () => { throw new Error("expected"); }));
  assert.equal(await withPersistenceLock("failure", async () => 42), 42);
});
