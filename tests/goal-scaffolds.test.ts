import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listScaffolds, loadScaffold } from "../goal-scaffolds.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "goal-scaffolds-"));
  return { root, dirs: { bundled: join(root, "bundled"), user: join(root, "user"), project: join(root, "project") } };
}

async function put(base: string, folder: string, contents: string) {
  await mkdir(join(base, folder), { recursive: true });
  await writeFile(join(base, folder, "SCAFFOLD.md"), contents);
}

const markdown = (name: string, body = name) => `---\nname: ${name}\ntitle: ${name} title\ndescription: ${name} description\nworkflow: observer-worker\nreviewEvery: 3\nwaitingAllowed: yes\n---\n${body}\n`;

test("loads scaffold policy and preserves project, user, bundled precedence", async () => {
  const { dirs } = await fixture();
  await put(dirs.bundled, "shared", markdown("shared", "bundled"));
  await put(dirs.user, "shared", markdown("shared", "user"));
  await put(dirs.project, "shared", markdown("shared", "project"));
  const loaded = await loadScaffold(dirs, "shared");
  assert.equal(loaded.source, "project");
  assert.equal(loaded.body, "project");
  assert.deepEqual(loaded.policy, { goalShape: undefined, workflow: "observer-worker", reviewEvery: 3, completionPolicy: undefined, blockedPolicy: undefined, waitingAllowed: true, mergePolicy: undefined });
  assert.equal(loaded.path, join(dirs.project, "shared", "SCAFFOLD.md"));
});

test("falls back through default and ultimately to the built-in default", async () => {
  const { dirs } = await fixture();
  await put(dirs.user, "default", markdown("default", "user default"));
  assert.equal((await loadScaffold(dirs, "missing")).body, "user default");
  const empty = await fixture();
  const fallback = await loadScaffold(empty.dirs, "missing");
  assert.equal(fallback.id, "default");
  assert.equal(fallback.source, "bundled");
  assert.equal(fallback.path, undefined);
});

test("listing applies override order and sorts deterministically by id", async () => {
  const { dirs } = await fixture();
  await put(dirs.bundled, "z", markdown("z"));
  await put(dirs.bundled, "shared", markdown("shared", "bundled"));
  await put(dirs.user, "a", markdown("a"));
  await put(dirs.project, "shared", markdown("shared", "project"));
  const listed = await listScaffolds(dirs);
  assert.deepEqual(listed.map(({ id }) => id), ["a", "default", "shared", "z"]);
  assert.equal(listed.find(({ id }) => id === "shared")?.source, "project");
});
