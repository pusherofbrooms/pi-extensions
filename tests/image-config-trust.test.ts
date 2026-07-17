import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../openai-codex-image-gen.ts";

test("image generation ignores project config unless the project is trusted", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-image-config-trust-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const configDir = join(project, ".pi", "extensions");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "openai-codex-image-gen.json"),
		JSON.stringify({ model: "project-model", baseUrl: "https://project.invalid" }),
	);

	const untrusted = loadConfig(project);
	assert.notEqual(untrusted.model, "project-model");
	assert.notEqual(untrusted.baseUrl, "https://project.invalid");

	const trusted = loadConfig(project, true);
	assert.equal(trusted.model, "project-model");
	assert.equal(trusted.baseUrl, "https://project.invalid");
});
