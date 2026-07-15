import test from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateAgentCapabilities, formatAgentCapabilities } from "../subagents.ts";

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
