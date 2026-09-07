import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "./agent-runner.ts" && context.parentURL?.endsWith("/subagents.ts")) {
    return { shortCircuit: true, url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(`
export { getFinalAssistantText } from ${JSON.stringify(new URL("../agent-runner.ts", import.meta.url).href)};
export const defaultAgentRunUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
export const runAgentSession = (options) => globalThis.__subagentTestRun(options);
`)}`)} };
  }
  return next(specifier, context);
}
`)}`, import.meta.url);
const { default: registerSubagents } = await import("../subagents.ts");

function setup(run: (options: any) => any, context = {}) {
  (globalThis as any).__subagentTestRun = run;
  let tool: any;
  registerSubagents({ registerTool(value: any) { tool = value; }, registerCommand() {}, on() {}, getThinkingLevel: () => "off" } as never);
  return (params: any) => tool.execute("test", { agentScope: "project", ...params }, undefined, undefined, { cwd: process.cwd(), hasUI: false, ...context });
}
const result = (output: string, extra = {}) => ({ messages: [{ role: "assistant", content: [{ type: "text", text: output }] }], exitCode: 0, usage: {}, ...extra });
const text = (value: any) => value.content.map((c: any) => c.text).join("\n");

test("parallel returns ordered, identified final findings without progress callbacks", async () => {
  const execute = setup(async ({ prompt }) => {
    if (prompt === "first") await new Promise(resolve => setTimeout(resolve, 10));
    return result(`${prompt} finding`);
  });
  const value = await execute({ tasks: [{ agent: "scout", task: "first" }, { agent: "scout", task: "second" }] });
  assert.match(text(value), /2\/2 succeeded/);
  assert.match(text(value), /Task 1: \[scout\].*completed\n\nfirst finding\n\n---\n\n### Task 2: \[scout\].*completed\n\nsecond finding/);
  assert.equal(value.details.results.length, 2);
});

test("parallel includes diagnostics, partial output, unknown agents and empty output", async () => {
  const execute = setup(({ prompt }) => prompt === "failed"
    ? result("partial finding", { exitCode: 1, stopReason: "error", errorMessage: "Synthetic error", stderr: "Synthetic stderr" })
    : result(""));
  const value = await execute({ tasks: [{ agent: "worker", task: "failed" }, { agent: "missing-test-agent", task: "unknown" }, { agent: "scout", task: "empty" }] });
  for (const expected of ["1/3 succeeded", "failed (exit 1, error)", "Synthetic error", "Synthetic stderr", "partial finding", "Unknown agent: missing-test-agent", "(no output)"]) assert.ok(text(value).includes(expected), expected);
});

test("single and chain keep existing content and previous-output substitution", async () => {
  const prompts: string[] = [];
  const execute = setup(({ prompt }) => { prompts.push(prompt); return result(prompt); });
  assert.equal(text(await execute({ agent: "scout", task: "single" })), "single");
  assert.equal(text(await execute({ chain: [{ agent: "scout", task: "first" }, { agent: "worker", task: "next {previous}" }] })), "next first");
  assert.deepEqual(prompts, ["single", "first", "next first"]);
});

test("parallel truncates each task independently and preserves full output in a file", async () => {
  const { readFile, rm } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  for (const large of ["line\n".repeat(2100), "🙂".repeat(20000)]) {
    const execute = setup(({ prompt }) => result(prompt === "large" ? large : "later finding"));
    const value = await execute({ tasks: [{ agent: "scout", task: "large" }, { agent: "worker", task: "small" }] });
    const output = text(value);
    const file = /Full output saved to: ([^\]]+)/.exec(output)?.[1];
    assert.ok(file);
    try {
      assert.equal(await readFile(file, "utf8"), large);
      assert.ok(output.includes("later finding"));
      assert.ok(Buffer.byteLength(output) < 53000);
      assert.equal(value.details.results[0].messages[0].content[0].text, large);
    } finally { await rm(dirname(file), { recursive: true, force: true }); }
  }
});

test("parallel joins final text blocks and treats error/abort stop reasons as failures", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const execute = setup(() => result("", { stopReason, messages: [{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "hidden" }, { type: "text", text: " second" }] }] }));
    const value = await execute({ tasks: [{ agent: "scout", task: "test" }] });
    assert.match(text(value), /0\/1 succeeded/);
    assert.ok(text(value).includes(`failed (exit 0, ${stopReason})`));
    assert.ok(text(value).includes("first second"));
    assert.ok(!text(value).includes("hidden"));
  }
});

test("regular agents load only selected inline tools in isolated SDK sessions", async (t) => {
  const { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-regular-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const expected: Record<string, string[]> = {
    scout: ["read", "grep", "find", "ls", "bash_read_only"],
    planner: ["read", "grep", "find", "ls", "bash_read_only"],
    reviewer: ["read", "grep", "find", "ls", "bash"],
    worker: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  };
  const execute = setup(async (options) => {
    assert.deepEqual(options.tools, expected[options.prompt]);
    const selected = options.tools.includes("bash_read_only");
    assert.equal(options.inlineExtensions?.length ?? 0, selected ? 1 : 0);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
      extensionFactories: options.inlineExtensions,
      noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
      sessionManager: SessionManager.inMemory(dir), tools: options.tools,
    });
    try {
      assert.deepEqual(session.agent.state.tools.map(tool => tool.name).sort(), [...options.tools].sort());
      const readOnly = session.agent.state.tools.find(tool => tool.name === "bash_read_only");
      if (selected) {
        assert.ok(readOnly);
        const output = await readOnly.execute("inspect", { executable: "uname", args: [] });
        assert.match(output.content.map((part: any) => part.text).join(""), /\[exit 0\]/);
        await assert.rejects(readOnly.execute("denied", { executable: "bash", args: ["-c", "true"] }), /Denied bash:/);
      }
    } finally { session.dispose(); }
    return result("ok");
  });
  for (const agent of Object.keys(expected)) await execute({ agent, task: agent });
});

test("trusted overrides select inline tools by tool name, not role name", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "pi-regular-override-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  for (const [name, tools] of [["scout", "read"], ["custom", "read, bash_read_only"], ["fallback", undefined]]) {
    await writeFile(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: Test override\n${tools ? `tools: ${tools}\n` : ""}---\nInspect only.\n`);
  }
  const runs: any[] = [];
  const execute = setup(options => { runs.push(options); return result("ok"); }, { cwd, isProjectTrusted: () => true });
  for (const agent of ["scout", "custom", "fallback"]) await execute({ agent, task: "inspect" });
  assert.deepEqual(runs[0].tools, ["read"]);
  assert.equal(runs[0].inlineExtensions, undefined);
  assert.deepEqual(runs[1].tools, ["read", "bash_read_only"]);
  assert.equal(runs[1].inlineExtensions.length, 1);
  assert.deepEqual(runs[2].tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.equal(runs[2].inlineExtensions, undefined);
});
