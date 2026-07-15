import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGitArgs, executeReadOnly, isBuiltInAllowed, isConfiguredAllowed, isConfined } from "../bash-read-only.ts";

test("built-in policy is deny-by-default and blocks streaming modes", () => {
  assert.equal(isBuiltInAllowed("ps", ["-ef"]), true);
  assert.equal(isBuiltInAllowed("journalctl", ["--no-pager", "-n", "20"]), true);
  assert.equal(isBuiltInAllowed("journalctl", ["-f"]), false);
  assert.equal(isBuiltInAllowed("tail", ["-f", "app.log"]), false);
  assert.equal(isBuiltInAllowed("sh", ["-c", "id"]), false);
  assert.equal(isBuiltInAllowed("/bin/ps", []), false);
});

test("trusted additions require an exact structured argument vector", () => {
  const rules = [{ executable: "custom-inspect", args: ["--summary"] }];
  assert.equal(isConfiguredAllowed("custom-inspect", ["--summary"], rules), true);
  assert.equal(isConfiguredAllowed("custom-inspect", ["--summary", "; id"], rules), false);
});

test("cwd confinement handles siblings and children", () => {
  assert.equal(isConfined("/work/project", "/work/project/sub"), true);
  assert.equal(isConfined("/work/project", "/work/project-other"), false);
});

test("execution uses literal args and confines cwd and tail realpaths", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-"));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "log"), "hello; echo injected\n");
  const result = await executeReadOnly("tail", ["-n", "1", "log"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(result.stdout, /hello; echo injected/);
  await assert.rejects(() => executeReadOnly("ps;id", [], undefined, root, 10_000, undefined, { allowGlobalAdditions: false }), /command name/);
  await assert.rejects(() => executeReadOnly("ps", [], "..", root, 10_000, undefined, { allowGlobalAdditions: false }), /cwd/);
  await assert.rejects(() => executeReadOnly("tail", ["-n", "1", "/etc/passwd"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false }), /escapes/);
});

test("policies require finite bounds and reject write or execution switches", () => {
  assert.equal(isBuiltInAllowed("tail", ["app.log"]), false);
  assert.equal(isBuiltInAllowed("tail", ["-n", "10001", "app.log"]), false);
  assert.equal(isBuiltInAllowed("journalctl", ["--no-pager", "-n", "1001"]), false);
  assert.equal(isBuiltInAllowed("date", ["--set", "tomorrow"]), false);
  assert.equal(isBuiltInAllowed("git", ["diff", "--ext-diff"]), false);
  assert.equal(isBuiltInAllowed("git", ["status", "--short"]), true);
  assert.equal(isBuiltInAllowed("git", ["branch", "new-branch"]), false);
  assert.equal(isBuiltInAllowed("git", ["branch", "--list"]), true);
  assert.equal(isBuiltInAllowed("ps", ["e"]), false);
  assert.deepEqual(buildGitArgs(["show", "HEAD"]), ["--no-pager", "-c", "core.fsmonitor=false", "show", "--no-ext-diff", "--no-textconv", "HEAD"]);
});

test("pre-aborted execution does not spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-abort-"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeReadOnly("uptime", [], undefined, root, 1000, controller.signal, { allowGlobalAdditions: false }), /before start/);
});
