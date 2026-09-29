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
  const loaded = await loadScaffold(dirs, "shared", true);
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
  const listed = await listScaffolds(dirs, true);
  assert.deepEqual(listed.map(({ id }) => id), ["a", "default", "shared", "z"]);
  assert.equal(listed.find(({ id }) => id === "shared")?.source, "project");
});

test("untrusted discovery and loading exclude project overrides and project-only scaffolds", async () => {
  const { dirs } = await fixture();
  for (const id of ["default", "shared"]) {
    await put(dirs.bundled, id, markdown(id, `bundled ${id}`));
    await put(dirs.project, id, markdown(id, `project ${id}`));
  }
  await put(dirs.user, "personal", markdown("personal", "user"));
  await put(dirs.project, "personal", markdown("personal", "project"));
  await put(dirs.project, "project-only", markdown("project-only"));
  const listed = await listScaffolds(dirs, false);
  assert.deepEqual(listed.map(({ id, source }) => [id, source]), [["default", "bundled"], ["personal", "user"], ["shared", "bundled"]]);
  assert.equal((await loadScaffold(dirs, "shared", false)).body, "bundled shared");
  assert.equal((await loadScaffold(dirs, "personal", false)).body, "user");
  assert.equal((await loadScaffold(dirs, "project-only", false)).body, "bundled default");
});

test("scaffold IDs cannot traverse from user directories into an untrusted project", async () => {
  const { dirs } = await fixture();
  await put(dirs.bundled, "default", markdown("default", "safe"));
  await put(dirs.project, "injected", markdown("injected", "project instructions"));
  for (const id of ["../project/injected", "..\\project\\injected"]) {
    assert.equal((await loadScaffold(dirs, id, false)).body, "safe");
  }
});

test("untrusted listing does not read the project directory", async () => {
  const { dirs } = await fixture();
  await writeFile(dirs.project, "not a directory");
  assert.equal((await listScaffolds(dirs, false))[0].source, "bundled");
  assert.equal((await loadScaffold(dirs, "default", false)).source, "bundled");
  await assert.rejects(listScaffolds(dirs, true), { code: "ENOTDIR" });
});
