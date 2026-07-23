import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import { buildGitArgs, childEnvironment, executeReadOnly, isBuiltInAllowed, isConfiguredAllowed } from "../bash-read-only.ts";

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

test("policy denials give concise actionable diagnostics", async () => {
  const options = { allowGlobalAdditions: false };
  await assert.rejects(() => executeReadOnly("git", ["show", "--format=%x09%H"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: unsupported format; use safe fields, %n, and literal separators/);
  await assert.rejects(() => executeReadOnly("git", ["show", "--format=%H", "--output=/tmp/result"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: arguments outside the safe inspection grammar/);
  await assert.rejects(() => executeReadOnly("git", ["show", "--format"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: unsupported format; use safe fields, %n, and literal separators/);
  await assert.rejects(() => executeReadOnly("tail", ["app.log"], undefined, process.cwd(), 1000, undefined, options),
    /Denied tail: require -n with 1\.\.10000 lines and a file/);
  await assert.rejects(() => executeReadOnly("journalctl", ["-n", "20"], undefined, process.cwd(), 1000, undefined, options),
    /Denied journalctl: require --no-pager and -n 0\.\.1000/);
  await assert.rejects(() => executeReadOnly("sh", ["-c", "id"], undefined, process.cwd(), 1000, undefined, options),
    /Denied sh: executable not allowlisted/);
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
  assert.equal(isBuiltInAllowed("git", ["branch", "--show-current"]), true);
  assert.equal(isBuiltInAllowed("git", ["branch", "--show-current", "extra"]), false);
  assert.equal(isBuiltInAllowed("git", ["branch", "--show-current", "--verbose"]), false);
  assert.equal(isBuiltInAllowed("git", ["remote", "-v"]), true);
  assert.equal(isBuiltInAllowed("git", ["remote", "--verbose"]), true);
  assert.equal(isBuiltInAllowed("git", ["remote"]), false);
  assert.equal(isBuiltInAllowed("git", ["remote", "-v", "extra"]), false);
  assert.equal(isBuiltInAllowed("git", ["remote", "get-url", "origin"]), false);
  assert.equal(isBuiltInAllowed("git", ["remote", "add", "origin", "https://example.com/repo.git"]), false);
  assert.equal(isBuiltInAllowed("ps", ["e"]), false);
  assert.deepEqual(buildGitArgs(["show", "HEAD"]), ["--no-pager", "-c", "core.fsmonitor=false", "show", "--no-ext-diff", "--no-textconv", "HEAD"]);
  assert.equal(isBuiltInAllowed("git", ["-C", "/tmp/repo", "--no-pager", "status", "--short"]), true);
  assert.equal(isBuiltInAllowed("git", ["-C", "/tmp/repo", "branch", "new"]), false);
  assert.equal(isBuiltInAllowed("git", ["--config-env=x=y", "status"]), false);
  assert.deepEqual(buildGitArgs(["-C", "../repo", "show", "HEAD"]), ["--no-pager", "-c", "core.fsmonitor=false", "-C", "../repo", "show", "--no-ext-diff", "--no-textconv", "HEAD"]);
});

test("git inspection policy allows safe output and selection options", () => {
  const allowed = [
    ["log", "--date=iso-strict", "--pretty=fuller", "--max-count", "20", "--author=Alice", "--grep", "fix", "--all"],
    ["log", "--date", "format:%Y-%m-%d %H:%M", "--format", "%h %aI %an %s%d", "--since", "2 weeks ago", "main..topic"],
    ["show", "--pretty=format:%H%n%an%n%s", "--name-status", "HEAD"],
    ["show", "--format=fuller", "--no-ext-diff", "--no-textconv", "HEAD"],
    ["diff", "--cached", "--stat", "--unified=20", "--", "src/file with spaces.ts"],
    ["diff", "--staged", "--check", "--no-renames", "HEAD~1", "HEAD"],
    ["log", "main..topic"], ["show", "HEAD^{commit}"],
    ["diff", "HEAD", "--", "src/-literal file.ts"],
  ];
  for (const args of allowed) assert.equal(isBuiltInAllowed("git", args), true, args.join(" "));
});

test("git inspection policy rejects execution, injection, writes, and unbounded formatting", () => {
  const denied = [
    ["log", "--exec=touch /tmp/pwn"], ["log", "-c", "core.pager=sh", "HEAD"], ["--config-env=x=y", "log"],
    ["diff", "--ext-diff"], ["diff", "--textconv"], ["diff", "--output=/tmp/diff"], ["diff", "--ita-invisible-in-index"],
    ["show", "--pretty=format:%(trailers)"], ["show", "--format=%x1b[31m%H"], ["show", "--format=%C(red)%H"],
    ["show", "--pretty=tformat:%H"], ["show", "--pretty=custom"], ["show", "--format"],
    ["log", "--date=not-a-date-mode"], ["log", "--date=format:%Y%n"], ["log", "--date"],
    ["log", "--max-count=10001"], ["log", "--skip=-1"], ["log", "--author="], ["log", "--unknown", "HEAD"],
    ["log", "--", "safe\nunsafe"], ["log", "HEAD@{1}"], ["show", "HEAD:path"], ["show", "HEAD^!"],
    ["diff", "HEAD", "main", "third"], ["diff", "--", ":(top)file"], ["diff", "--", "*.ts"],
    ["diff", "--", "[ab].txt"], ["diff", "--", "!excluded"],
    ["archive", "HEAD"], ["checkout", "main"], ["tag", "new-tag"],
  ];
  for (const args of denied) assert.equal(isBuiltInAllowed("git", args), false, args.join(" "));
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

test("rg policy allows reconnaissance and rejects indirection and unknown options", () => {
  const allowed = [
    ["-n", "--hidden", "-S", "PATTERN", "PATH"],
    ["--files", "--hidden", "-g", "*.ts", "src"],
    ["-n", "-C", "3", "-m", "100", "-t", "ts", "--glob=!.git/**", "TODO", "."],
    ["--files-with-matches", "--no-heading", "--color=never", "-e", "-leading", "--", "-path"],
    ["--", "-pattern", "."],
    ["--type-list"],
  ];
  for (const args of allowed) assert.equal(isBuiltInAllowed("rg", args), true, args.join(" "));

  const denied = [
    ["--pre", "cat", "x"], ["--pre-glob", "*.zip", "x"], ["-f", "patterns", "."], ["--file=patterns", "."],
    ["--files-from", "paths"], ["--config-path", "config", "x"], ["--unknown", "x"], ["-C", "101", "x"],
    ["-m", "10001", "x"], ["-e"], ["-leading", "."], ["--files", "-e", "x"],
    ["--sort", "name", "x"], ["--sort=name", "x"], ["--glob", "", "x"], ["--glob=", "x"],
    ["--files", "--type-list"], ["-nS", "x"], ["-C3", "x"], ["-tts", "x"],
  ];
  assert.equal(isBuiltInAllowed("rg", ["--sort", "path", "x"]), true);
  assert.equal(isBuiltInAllowed("rg", ["--sort=modified", "x"]), true);
  for (const args of denied) assert.equal(isBuiltInAllowed("rg", args), false, args.join(" "));
});

test("child environment inherits only PATH and falls back when absent", () => {
  const inherited = childEnvironment({ PATH: "/pi/trusted/bin", SECRET: "do-not-copy", HOME: "/parent/home" });
  assert.equal(inherited.PATH, "/pi/trusted/bin");
  assert.equal(inherited.SECRET, undefined);
  assert.equal(inherited.HOME, "/nonexistent");
  assert.equal(childEnvironment({}).PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(childEnvironment({ PATH: "" }).PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("external rg executes by command name from the parent PATH", async (t) => {
  try { await promisify(execFile)("rg", ["--version"]); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("rg unavailable on PATH"); return; }
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), "bash-ro-rg-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "sample.txt"), "needle\n");
  const result = await executeReadOnly("rg", ["-n", "needle", "."], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(result.stdout, /1:needle/);
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
