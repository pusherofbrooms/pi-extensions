import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import { buildGitArgs, executeReadOnly, isBuiltInAllowed, isConfiguredAllowed } from "../bash-read-only.ts";

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

test("execution uses literal args and permits readable paths and cwd outside the session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-"));
  const external = await mkdtemp(join(tmpdir(), "bash-ro-external-"));
  t.after(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]); });
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "log"), "hello; echo injected\n");
  await writeFile(join(external, "outside"), "outside\n");
  const result = await executeReadOnly("tail", ["-n", "1", "log"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(result.stdout, /hello; echo injected/);
  await assert.rejects(() => executeReadOnly("ps;id", [], undefined, root, 10_000, undefined, { allowGlobalAdditions: false }), /command name/);
  const externalResult = await executeReadOnly("tail", ["-n", "1", "outside"], external, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(externalResult.stdout, /outside/);
  const absoluteResult = await executeReadOnly("tail", ["-n", "1", join(root, "log")], external, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(absoluteResult.stdout, /hello; echo injected/);
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
  assert.equal(isBuiltInAllowed("git", ["-C", "/tmp/repo", "--no-pager", "status", "--short"]), true);
  assert.equal(isBuiltInAllowed("git", ["-C", "/tmp/repo", "branch", "new"]), false);
  assert.equal(isBuiltInAllowed("git", ["--config-env=x=y", "status"]), false);
  assert.deepEqual(buildGitArgs(["-C", "../repo", "show", "HEAD"]), ["--no-pager", "-c", "core.fsmonitor=false", "-C", "../repo", "show", "--no-ext-diff", "--no-textconv", "HEAD"]);
});

test("find policy accepts a positive inspection grammar", () => {
  const allowed = [
    ["."] ,
    ["/tmp", "-maxdepth", "2", "-type", "f", "-name", "*.log", "-print"],
    ["src", "tests", "(", "-name", "*.ts", "-o", "-iname", "*.mjs", ")", "-print0"],
    [".", "-name", "literal", "-printf", "%p\\n"],
  ];
  for (const args of allowed) assert.equal(isBuiltInAllowed("find", args), true, args.join(" "));

  const denied = [
    [".", "-exec", "id", ";"], [".", "-execdir", "id", ";"], [".", "-ok", "id", ";"], [".", "-okdir", "id", ";"], [".", "-delete"],
    [".", "-fprint", "/tmp/out"], [".", "-fprint0", "/tmp/out"], [".", "-fprintf", "/tmp/out", "%p"], [".", "-fls", "/tmp/out"], ["-files0-from", "paths"],
    [".", "-name", "-exec"], ["-exec"], [".", "-unknown"], [".", "-maxdepth", "many"], [".", "-name"], [".", "-type", "z"], [".", "-xtype", "ff"],
    [".", "("], [".", ")"], [".", "(", "-print"], [".", "-print", ")"], [".", "-print", "-o"], [".", "!"], [".", "-not", "-and", "-print"], [".", "-a", "-print"],
  ];
  for (const args of denied) assert.equal(isBuiltInAllowed("find", args), false, args.join(" "));
});

test("external find and git -C execute through the policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-tools-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "sample.txt"), "sample\n");
  const found = await executeReadOnly("find", [root, "-maxdepth", "1", "-type", "f", "-name", "*.txt", "-print"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(found.stdout, /sample\.txt/);
  await promisify(execFile)("git", ["init", "--quiet", root]);
  const git = await executeReadOnly("git", ["-C", root, "rev-parse", "--show-toplevel"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.equal(git.stdout.trim(), await realpath(root));
});

test("pre-aborted execution does not spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-abort-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeReadOnly("uptime", [], undefined, root, 1000, controller.signal, { allowGlobalAdditions: false }), /before start/);
});
