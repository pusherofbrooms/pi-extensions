import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import { buildJournalArgs, buildGitArgs, childEnvironment, executeReadOnly, isBuiltInAllowed, isConfiguredAllowed } from "../bash-read-only.ts";

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
  await assert.rejects(() => executeReadOnly("git", ["show", "--pretty=custom"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: unsupported format; use a named style/);
  await assert.rejects(() => executeReadOnly("git", ["show", "--format=%H", "--output=/tmp/result"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: output-file option --output is denied/);
  await assert.rejects(() => executeReadOnly("git", ["show", "--format"], undefined, process.cwd(), 1000, undefined, options),
    /Denied git: unsupported format; use a named style/);
  await assert.rejects(() => executeReadOnly("tail", ["-f", "app.log"], undefined, process.cwd(), 1000, undefined, options),
    /Denied tail: use a regular file/);
  await assert.rejects(() => executeReadOnly("journalctl", ["-n", "1001"], undefined, process.cwd(), 1000, undefined, options),
    /Denied journalctl: use query options/);
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
  assert.equal(isBuiltInAllowed("tail", ["app.log"]), true);
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
  assert.equal(isBuiltInAllowed("git", ["remote", "get-url", "origin"]), true);
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

test("new inspection utilities allow useful reads and deny external/program-loading modes", () => {
  const allowed: Array<[string, string[]]> = [
    ["ls", ["-lah", "--", "."]], ["stat", ["--printf=%s\\n", "file"]],
    ["which", ["git"]], ["which", ["-a", "node", "rg"]], ["which", ["-s", "--", "-tool"]],
    ["file", ["--brief", "file"]], ["head", ["-n", "20", "file"]], ["wc", ["-l", "file"]],
    ["du", ["-sh", "."]], ["readlink", ["-f", "link"]], ["realpath", ["--relative-to=.", "file"]],
    ["jq", ["-r", ".name // empty", "data.json"]], ["jq", ["-n", "--arg", "x", "value", "$x"]],
  ];
  for (const [executable, args] of allowed) assert.equal(isBuiltInAllowed(executable, args), true, `${executable} ${args.join(" ")}`);

  const denied: Array<[string, string[]]> = [
    ["which", []], ["which", ["-a"]], ["which", ["--read-alias", "git"]],
    ["which", ["--read-functions", "git"]], ["which", ["/bin/sh"]], ["which", ["git\nsh"]],
    ["file", ["-m", "custom.magic", "file"]], ["file", ["-mcustom.magic", "file"]],
    ["file", ["--magic-file=custom.magic", "file"]], ["file", ["-Mcustom.magic", "file"]],
    ["file", ["-S", "file"]], ["file", ["--no-sandbox", "file"]], ["file", ["-z", "archive.gz"]],
    ["jq", ["-L", "modules", "import \"x\" as x; x"]], ["jq", ["-Lmodules", "import \"x\" as x; x"]],
    ["jq", ["--library-path=modules", "import \"x\" as x; x"]], ["jq", ["-f", "filter.jq", "data.json"]],
    ["jq", ["--slurpfile", "x", "other.json", "."]], ["jq", ["include \"helpers\"; helpers", "data.json"]],
  ];
  for (const [executable, args] of denied) assert.equal(isBuiltInAllowed(executable, args), false, `${executable} ${args.join(" ")}`);
});

test("jq denies module loading in varied placements but allows keywords in strings", () => {
  const denied = [
    "  import \"helpers\" as h; h::run",
    "(include \"helpers\"; helpers)",
    ". as $x |\ninclude \"helpers\"; helpers",
    "[1] | (\n  import \"helpers\" as h; h::run\n)",
  ];
  for (const filter of denied) assert.equal(isBuiltInAllowed("jq", [filter]), false, filter);

  const allowed = [
    '"import \\"helpers\\" as h"',
    '{message: "include helpers"}',
    '"quoted: \\\"include helpers\\\""',
    '["import", "include"]',
  ];
  for (const filter of allowed) assert.equal(isBuiltInAllowed("jq", [filter]), true, filter);
});

test("additional Git inspection subcommands deny writers and external helpers", () => {
  const allowed = [
    ["ls-files", "--cached", "--others", "--exclude-standard"], ["ls-files", "-co"],
    ["ls-files", "--", "-co"],
    ["grep", "-n", "-i", "needle", "--", "src"], ["grep", "-ni", "needle"],
    ["grep", "-A3", "-e", "needle"], ["grep", "--regexp=needle"],
    ["grep", "-fpatterns.txt"], ["grep", "--file", "patterns.txt"],
    ["grep", "-e", "needle", "--", "-path"], ["grep", "--", "-pattern"],
    ["blame", "--line-porcelain", "HEAD", "--", "src/file.ts"],
    ["ls-tree", "-r", "--name-only", "HEAD"], ["ls-tree", "-rl", "HEAD"],
    ["cat-file", "-p", "HEAD^{tree}"], ["cat-file", "--batch-all-objects", "--batch-check"],
  ];
  for (const args of allowed) assert.equal(isBuiltInAllowed("git", args), true, args.join(" "));
  const denied = [
    ["grep", "-O", "evil", "needle"], ["grep", "-Oevil", "needle"],
    ["grep", "-nOevil", "needle"], ["grep", "-nz", "needle"], ["ls-files", "-cQ"], ["ls-tree", "-rx", "HEAD"],
    ["grep", "-e"], ["grep", "--regexp="], ["grep", "-f"], ["grep", "--file="],
    ["grep", "--open-files-in-pager=less", "needle"], ["grep", "--ext-grep", "needle"],
    ["grep", "--textconv", "needle"], ["cat-file", "--filters", "HEAD:file"],
    ["cat-file", "--filters=HEAD:file"], ["cat-file", "--textconv", "HEAD:file"],
    ["blame", "--output", "result", "file"], ["blame", "--output=result", "file"],
  ];
  for (const args of denied) assert.equal(isBuiltInAllowed("git", args), false, args.join(" "));
});

test("git inspection policy rejects execution, injection, writes, and unbounded formatting", () => {
  const denied = [
    ["log", "--exec=touch /tmp/pwn"], ["log", "-c", "core.pager=sh", "HEAD"], ["--config-env=x=y", "log"],
    ["diff", "--ext-diff"], ["diff", "--textconv"], ["diff", "--output=/tmp/diff"], ["diff", "--ita-invisible-in-index"],

    ["show", "--pretty=custom"], ["show", "--format"],
    ["log", "--date=not-a-date-mode"], ["log", "--date=format:%Y%n"], ["log", "--date"],
    ["log", "--max-count=10001"], ["log", "--skip=-1"], ["log", "--author="], ["log", "--unknown", "HEAD"],
    ["log", "--", "safe\nunsafe"],
    ["diff", "HEAD", "main", "third"],

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
    ["-m", "10001", "x"], ["-e"], ["--files", "-e", "x"],
    ["--sort", "name", "x"], ["--sort=name", "x"], ["--glob", "", "x"], ["--glob=", "x"],
    ["--files", "--type-list"],
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

test("new filesystem utilities execute with literal operands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-basic-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "sample.txt"), "one\ntwo\n");
  const head = await executeReadOnly("head", ["-n", "1", "sample.txt"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.equal(head.stdout, "one\n");
  const wc = await executeReadOnly("wc", ["-l", "sample.txt"], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.match(wc.stdout, /^\s*2\s+sample\.txt/);
  const listing = await executeReadOnly("ls", ["-1", "--", "."], undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.equal(listing.stdout, "sample.txt\n");
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
  await promisify(execFile)("git", ["-C", root, "add", "sample.txt"]);
  await promisify(execFile)("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "sample"]);
  const inspect = (args: string[]) => executeReadOnly("git", args, undefined, root, 10_000, undefined, { allowGlobalAdditions: false });
  assert.equal((await inspect(["show", "HEAD:sample.txt"])).stdout, "sample\n");
  assert.match((await inspect(["log", "-n", "5", "--pretty=tformat:%s%x09%h", "--", ":(glob)*.txt"])).stdout, /^sample\t[0-9a-f]+\n$/);
  for (const sub of ["log", "show", "diff"]) {
    for (const option of ["--format", "--since", "--until", "--author", "--committer", "--grep"]) {
      for (const existing of [false, true]) {
        const output = join(root, "result");
        if (existing) await writeFile(output, "sentinel");
        else await rm(output, { force: true });
        const args = [sub, option, "--output=" + output, "-n", "1"];
        assert.equal(isBuiltInAllowed("git", args), true);
        await inspect(args);
        if (existing) assert.equal(await readFile(output, "utf8"), "sentinel", args.join(" "));
        else await assert.rejects(readFile(output), { code: "ENOENT" });
      }
    }
  }
  for (const option of ["--pretty", "--date", "--max-count", "--skip", "-n"]) {
    await assert.rejects(inspect(["log", option, "--output=" + join(root, "result")]), /Denied git/);
    assert.equal(await readFile(join(root, "result"), "utf8"), "sentinel");
  }
  assert.equal((await inspect(["log", "--format", "%s", "-n", "1"])).stdout, "sample\n");
  assert.equal((await inspect(["log", "--pretty", "tformat:%s", "-n", "1"])).stdout, "sample\n");
  assert.match((await inspect(["log", "--date", "format:%Y", "--format", "%ad", "-n", "1"])).stdout, /^\d{4}\n$/);
  assert.equal((await inspect(["blame", "--date", "short", "sample.txt"])).code, 0);
  assert.equal((await inspect(["status", "-sb"])).code, 0);
  assert.equal((await inspect(["describe", "--always"])).code, 0);
  assert.equal((await inspect(["merge-base", "HEAD", "HEAD"])).code, 0);

});

test("pre-aborted execution does not spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-abort-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => executeReadOnly("uptime", [], undefined, root, 1000, controller.signal, { allowGlobalAdditions: false }), /before start/);
});

test("ordinary inspection syntax and bounded defaults", async (t) => {
  for (const args of [
    ["log", "-n", "5"], ["status", "-sb"], ["show", "HEAD:path"],
    ["log", "HEAD@{1}", "HEAD~2^!"], ["show", "--pretty=tformat:%H%x09%an"],
    ["show", "--format=%C(auto)%h %<(20)%s %(trailers)"],
    ["diff", "--", ":(glob,top)**/*.ts", ":(exclude)tests/**"],
    ["remote", "get-url", "--all", "origin"], ["describe", "--tags", "--always"],
    ["merge-base", "--is-ancestor", "HEAD~1", "HEAD"],
  ]) assert.equal(isBuiltInAllowed("git", args), true, args.join(" "));
  for (const args of [["-nS", "x"], ["-C3", "x"], ["-tts", "x"], ["-nig*.ts", "x"]])
    assert.equal(isBuiltInAllowed("rg", args), true);
  for (const args of [["-nSfsecret", "x"], ["-C101", "x"], ["-nC"], ["-nQ", "x"]])
    assert.equal(isBuiltInAllowed("rg", args), false);
  assert.equal(isBuiltInAllowed("find", [".", "-name", ".git", "-prune", "-o", "-print"]), true);
  assert.equal(isBuiltInAllowed("journalctl", []), true);
  assert.equal(isBuiltInAllowed("journalctl", ["-u", "service"]), true);
  assert.deepEqual(buildJournalArgs(["-n", "20"]), ["--no-pager", "-n", "100", "-n", "20"]);
  for (const args of [["remote", "set-url", "origin", "url"], ["describe", "--output=x"], ["merge-base", "--output=x", "HEAD", "main"]])
    assert.equal(isBuiltInAllowed("git", args), false);
  const root = await mkdtemp(join(tmpdir(), "bash-ro-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "log"), Array.from({ length: 20 }, (_, i) => i + "\n").join(""));
  const result = await executeReadOnly("tail", ["log"], undefined, root, 1000, undefined, { allowGlobalAdditions: false });
  assert.equal(result.stdout, Array.from({ length: 10 }, (_, i) => (i + 10) + "\n").join(""));
});

test("journal execution injects defaults before explicit line overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bash-ro-journal-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  // A PATH fixture exercises the real spawn path without requiring a system journal.
  const executable = join(root, "journalctl");
  await writeFile(executable, "#!" + process.execPath + "\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");
  await chmod(executable, 0o755);
  process.env.PATH = root;
  for (const args of [[], ["-n", "0"], ["--lines=20"], ["--lines", "5"]]) {
    const result = await executeReadOnly("journalctl", args, undefined, root, 1000, undefined, { allowGlobalAdditions: false });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["--no-pager", "-n", "100", ...args]);
  }
});

test("git inspection diagnostics report names, not values or path operands", async () => {
  const deny = (args: string[]) => executeReadOnly("git", args, undefined, process.cwd(), 1000, undefined, { allowGlobalAdditions: false });
  for (const [args, message] of [
    [["log", "--unsupported"], /unsupported inspection option --unsupported;/],
    [["log", "--output=/sensitive"], /output-file option --output is denied/],
    [["log", "--ext-diff"], /external-helper option --ext-diff is denied/],
    [["log", "-n", "invalid"], /missing or invalid value for option -n;/],
    [["log", "-n"], /missing or invalid value for option -n;/],
    [["diff", "a", "b", "c", "--", "--pretty=custom"], /too many diff revisions/],
    [["log", "--grep", "--pretty=custom", "--unsupported"], /unsupported inspection option --unsupported;/],
  ] as [string[], RegExp][]) {
    await assert.rejects(deny(args), (error: Error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /sensitive|custom/);
      return true;
    });
  }
  assert.equal(isBuiltInAllowed("git", ["log", "--", "--pretty=custom", "--output=/sensitive"]), true);
});
