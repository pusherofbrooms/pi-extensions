import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateAgentCapabilities, formatAgentCapabilities, parseThinkingLevel } from "../subagents.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("subagent capability catalog exposes names, descriptions, and tools", () => {
	const capabilities = enumerateAgentCapabilities(root, "user");
	const byName = new Map(capabilities.map((agent) => [agent.name, agent]));

	assert.deepEqual([...byName.keys()].sort(), ["planner", "reviewer", "scout", "worker"]);
	assert.deepEqual(byName.get("scout")?.tools, ["read", "grep", "find", "ls"]);
	assert.ok(byName.get("worker")?.tools.includes("edit"));

	const description = formatAgentCapabilities(capabilities);
	assert.match(description, /use only these exact names/i);
	assert.match(description, /scout .*tools: read, grep, find, ls/);
	assert.match(description, /worker .*tools: .*edit/);
});

test("project agents are only discovered for trusted projects", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-subagents-trust-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const agentsDir = join(project, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentsDir, "local.md"), "---\nname: local\ndescription: Project agent\ntools: read\n---\nProject instructions.\n");

	const untrusted = enumerateAgentCapabilities(project, "both");
	assert.equal(untrusted.some((agent) => agent.name === "local"), false);
	assert.equal(untrusted.some((agent) => agent.source === "project"), false);

	const trusted = enumerateAgentCapabilities(project, "both", true);
	assert.equal(trusted.find((agent) => agent.name === "local")?.source, "project");
});

test("agent thinking levels are normalized and invalid values fail clearly", () => {
	assert.equal(parseThinkingLevel(undefined), undefined);
	assert.equal(parseThinkingLevel(" Low "), "low");
	assert.equal(parseThinkingLevel("xhigh"), "xhigh");
	assert.throws(() => parseThinkingLevel(""), /Invalid agent thinking level/);
	assert.throws(() => parseThinkingLevel(null), /Invalid agent thinking level/);
	assert.throws(() => parseThinkingLevel(3), /Invalid agent thinking level/);
	assert.throws(() => parseThinkingLevel("extreme"), /Invalid agent thinking level/);
});
