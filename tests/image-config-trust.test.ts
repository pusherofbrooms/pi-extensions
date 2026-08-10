import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenAICodexToken, loadConfig } from "../openai-codex-image-gen.ts";

test("image generation resolves the Codex token through provider auth", async () => {
	let requestedProvider: string | undefined;
	const token = await getOpenAICodexToken({
		modelRegistry: {
			async getProviderAuth(provider) {
				requestedProvider = provider;
				return { auth: { apiKey: "test-token" } };
			},
		},
	});

	assert.equal(requestedProvider, "openai-codex");
	assert.equal(token, "test-token");
});

test("image generation reports missing provider auth", async () => {
	await assert.rejects(
		getOpenAICodexToken({
			modelRegistry: { async getProviderAuth() { return undefined; } },
		}),
		/Missing OpenAI Codex OAuth credentials/,
	);
});

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
