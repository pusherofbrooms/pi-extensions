/**
 * OpenAI Codex Image Generation
 *
 * Generates images through the ChatGPT/Codex backend using Pi's existing
 * openai-codex OAuth login. This does not require an OpenAI API key.
 *
 * Usage:
 *   1. Run /login and authenticate the openai-codex provider.
 *   2. Load this extension:
 *      pi -e ./packages/coding-agent/examples/extensions/openai-codex-image-gen.ts
 *   3. Ask Pi to generate an image.
 *
 * Save modes (tool param, env var, or config file):
 *   save=none     - Don't save to disk (default)
 *   save=project  - Save to <repo>/.pi/generated-images/
 *   save=global   - Save to ~/.pi/agent/generated-images/
 *   save=custom   - Save to saveDir param or PI_OPENAI_IMAGE_SAVE_DIR
 *
 * Environment variables:
 *   PI_OPENAI_IMAGE_SAVE_MODE  - Default save mode (none|project|global|custom)
 *   PI_OPENAI_IMAGE_SAVE_DIR   - Directory for custom save mode
 *   PI_OPENAI_IMAGE_MODEL      - Override the default Codex model
 *
 * Config files (project overrides global):
 *   ~/.pi/agent/extensions/openai-codex-image-gen.json
 *   <repo>/.pi/extensions/openai-codex-image-gen.json
 *   Example: { "save": "global", "model": "gpt-5.5" }
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_SAVE_MODE = "none";

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image description." }),
	model: Type.Optional(
		Type.String({
			description: "Codex model id. Defaults to current openai-codex model, PI_OPENAI_IMAGE_MODEL, or gpt-5.5.",
		}),
	),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save image when save=custom. Defaults to PI_OPENAI_IMAGE_SAVE_DIR if set.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface ExtensionConfig {
	save?: SaveMode;
	saveDir?: string;
	model?: string;
	baseUrl?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface ImageResult {
	id: string;
	data: string;
	revisedPrompt?: string;
}

function readConfigFile(path: string): ExtensionConfig {
	if (!existsSync(path)) {
		return {};
	}
	try {
		return (JSON.parse(readFileSync(path, "utf-8")) as ExtensionConfig) ?? {};
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): ExtensionConfig {
	const globalPath = join(getAgentDir(), "extensions", "openai-codex-image-gen.json");
	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", "openai-codex-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

function resolveSaveConfig(params: ToolParams, cwd: string): SaveConfig {
	const config = loadConfig(cwd);
	const envMode = (process.env.PI_OPENAI_IMAGE_SAVE_MODE || "").toLowerCase();
	const mode = (params.save || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;

	if (!SAVE_MODES.includes(mode)) {
		return { mode: DEFAULT_SAVE_MODE as SaveMode };
	}

	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".pi", "generated-images") };
	}

	if (mode === "global") {
		return { mode, outputDir: join(getAgentDir(), "generated-images") };
	}

	if (mode === "custom") {
		const dir = params.saveDir || process.env.PI_OPENAI_IMAGE_SAVE_DIR || config.saveDir;
		if (!dir || !dir.trim()) {
			throw new Error("save=custom requires saveDir or PI_OPENAI_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: dir };
	}

	return { mode };
}

function resolveModel(params: ToolParams, ctx: { cwd: string; model?: { provider: string; id: string } }): string {
	const config = loadConfig(ctx.cwd);
	if (params.model) return params.model;
	if (process.env.PI_OPENAI_IMAGE_MODEL) return process.env.PI_OPENAI_IMAGE_MODEL;
	if (config.model) return config.model;
	if (ctx.model?.provider === PROVIDER && ctx.model.id) return ctx.model.id;
	return DEFAULT_MODEL;
}

function resolveBaseUrl(cwd: string): string {
	const config = loadConfig(cwd);
	return (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function resolveCodexResponsesUrl(cwd: string): string {
	const base = resolveBaseUrl(cwd);
	if (base.endsWith("/codex/responses")) return base;
	if (base.endsWith("/codex")) return `${base}/responses`;
	return `${base}/codex/responses`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) {
		throw new Error("Invalid OpenAI Codex OAuth token.");
	}
	const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
	return JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>;
}

function extractAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const authClaim = payload[JWT_CLAIM_PATH];
	const accountId =
		authClaim && typeof authClaim === "object" && "chatgpt_account_id" in authClaim
			? authClaim.chatgpt_account_id
			: undefined;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Could not extract ChatGPT account id from OpenAI Codex OAuth token.");
	}
	return accountId;
}

function createRequestId(): string {
	return typeof globalThis.crypto?.randomUUID === "function"
		? globalThis.crypto.randomUUID()
		: `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildRequestBody(prompt: string, model: string) {
	return {
		model,
		store: false,
		stream: true,
		instructions:
			"You are an image generation agent. Use the image_generation tool to create the requested image. Do not answer with text only.",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: prompt }],
			},
		],
		tools: [{ type: "image_generation", output_format: "png" }],
		tool_choice: "auto",
		parallel_tool_calls: false,
	};
}

function buildHeaders(token: string, accountId: string): Headers {
	const requestId = createRequestId();
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", `pi (${process.platform} ${process.arch})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("session_id", requestId);
	headers.set("x-client-request-id", requestId);
	return headers;
}

async function parseSseForImage(response: Response, signal?: AbortSignal): Promise<ImageResult> {
	if (!response.body) {
		throw new Error("No response body.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted.");
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const data = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n")
					.trim();

				if (data && data !== "[DONE]") {
					const parsed = JSON.parse(data) as {
						type?: string;
						item?: {
							id?: string;
							type?: string;
							result?: string;
							revised_prompt?: string;
						};
						response?: {
							output?: Array<{
								id?: string;
								type?: string;
								result?: string;
								revised_prompt?: string;
							}>;
							error?: { message?: string };
						};
						message?: string;
					};

					if (parsed.type === "error") {
						throw new Error(parsed.message || "Codex image generation failed.");
					}
					if (parsed.type === "response.failed") {
						throw new Error(parsed.response?.error?.message || "Codex image generation failed.");
					}

					const item = parsed.item;
					if (item?.type === "image_generation_call" && item.result) {
						return { id: item.id || "image_generation", data: item.result, revisedPrompt: item.revised_prompt };
					}

					for (const output of parsed.response?.output || []) {
						if (output.type === "image_generation_call" && output.result) {
							return {
								id: output.id || "image_generation",
								data: output.result,
								revisedPrompt: output.revised_prompt,
							};
						}
					}
				}

				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}

	throw new Error("No image_generation_call result was returned.");
}

async function saveImage(base64Data: string, outputDir: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `openai-image-${timestamp}-${randomUUID().slice(0, 8)}.png`;
	const filePath = join(outputDir, filename);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(filePath, Buffer.from(base64Data, "base64"));
	});
	return filePath;
}

async function getOpenAICodexToken(ctx: {
	modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
}): Promise<string> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!token) {
		throw new Error("Missing OpenAI Codex OAuth credentials. Run /login for openai-codex.");
	}
	return token;
}

export default function openaiCodexImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_openai_image",
		label: "Generate OpenAI image",
		description:
			"Generate an image through the ChatGPT/Codex backend using the existing openai-codex OAuth login. Returns the image as a tool result attachment. Optional saving via save=project|global|custom|none.",
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const token = await getOpenAICodexToken(ctx);
			const accountId = extractAccountId(token);
			const model = resolveModel(params, ctx);

			onUpdate?.({
				content: [{ type: "text", text: `Requesting image from ${PROVIDER}/${model}...` }],
				details: { provider: PROVIDER, model },
			});

			const response = await fetch(resolveCodexResponsesUrl(ctx.cwd), {
				method: "POST",
				headers: buildHeaders(token, accountId),
				body: JSON.stringify(buildRequestBody(params.prompt, model)),
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new Error(`Image request failed (${response.status}): ${errorText || response.statusText}`);
			}

			const image = await parseSseForImage(response, signal);
			const saveConfig = resolveSaveConfig(params, ctx.cwd);
			let savedPath: string | undefined;
			let saveError: string | undefined;

			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				try {
					savedPath = await saveImage(image.data, saveConfig.outputDir);
				} catch (error) {
					saveError = error instanceof Error ? error.message : String(error);
				}
			}

			const summaryParts = [`Generated image via ${PROVIDER}/${model}.`];
			if (image.revisedPrompt) summaryParts.push(`Revised prompt: ${image.revisedPrompt}`);
			if (savedPath) summaryParts.push(`Saved image to: ${savedPath}`);
			if (saveError) summaryParts.push(`Failed to save image: ${saveError}`);

			return {
				content: [
					{ type: "text", text: summaryParts.join(" ") },
					{ type: "image", data: image.data, mimeType: "image/png" },
				],
				details: {
					provider: PROVIDER,
					model,
					imageId: image.id,
					savedPath,
					saveMode: saveConfig.mode,
				},
			};
		},
	});
}
