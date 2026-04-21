import * as fs from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	parseFrontmatter,
	SessionManager,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { improved, parseMetric, validateLoopConfig } from "./subagents-core.mjs";

console.error("[subagents] loaded", { processCwd: process.cwd() });

type AgentScope = "user" | "project" | "both";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "default";
	filePath: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "default" | "unknown";
	task: string;
	messages: Message[];
	exitCode: number;
	stderr?: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "loop";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	loop?: {
		iterations: number;
		bestMetric?: number;
		objective: "min" | "max";
	};
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const MODULE_DIR = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS_DIR = path.join(MODULE_DIR, "agents");

function defaultUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "default"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!isDirectory(dir)) return agents;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function loadDefaultAgents(): AgentConfig[] {
	return loadAgentsFromDir(DEFAULT_AGENTS_DIR, "default");
}

function discoverAgents(cwd: string, scope: AgentScope): { agents: AgentConfig[]; projectAgentsDir: string | null } {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const defaultAgents = loadDefaultAgents();
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const byName = new Map<string, AgentConfig>();

	// Fallback baseline
	for (const a of defaultAgents) byName.set(a.name, a);

	// User/project agents override fallback defaults by name.
	if (scope === "both") {
		for (const a of userAgents) byName.set(a.name, a);
		for (const a of projectAgents) byName.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) byName.set(a.name, a);
	} else {
		for (const a of projectAgents) byName.set(a.name, a);
	}

	return { agents: Array.from(byName.values()), projectAgentsDir };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function resolveModel(spec: string | undefined, ctx: Parameters<NonNullable<ExtensionAPI["registerTool"]>["0"]["execute"]>[4]): Model<any> | undefined {
	if (!spec) return undefined;
	const clean = spec.trim();
	if (!clean.includes("/")) return undefined;
	const [provider, id] = clean.split("/", 2);
	if (!provider || !id) return undefined;
	return ctx.modelRegistry.find(provider, id);
}

function getToolNames(names?: string[]) {
	return names && names.length > 0 ? names : ["read", "bash", "edit", "write", "grep", "find", "ls"];
}

function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source})`).join(", ");
}

function isValidAgentCommandName(name: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name);
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	runCwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	ctx: Parameters<NonNullable<ExtensionAPI["registerTool"]>["0"]["execute"]>[4],
	onUpdate: Parameters<NonNullable<ExtensionAPI["registerTool"]>["0"]["execute"]>[3],
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	console.error("[subagents] runSingleAgent:start", {
		defaultCwd,
		runCwd,
		agentName,
		step,
		taskLength: task.length,
	});
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			messages: [],
			exitCode: 1,
			stderr: `Unknown agent: ${agentName}`,
			usage: defaultUsage(),
			step,
		};
	}

	const cwd = runCwd ?? defaultCwd;
	console.error("[subagents] runSingleAgent:resolved", {
		cwd,
		agentSource: agent.source,
		tools: agent.tools,
		model: agent.model,
	});
	let inheritedModel: Model<any> | undefined;
	let inheritedModelLabel: string | undefined;
	try {
		console.error("[subagents] runSingleAgent:before-ctx-model", { cwd, explicitModel: agent.model });
		inheritedModel = ctx.model;
		console.error("[subagents] runSingleAgent:after-ctx-model", {
			cwd,
			hasModel: Boolean(inheritedModel),
		});
		const inheritedProvider = inheritedModel?.provider;
		console.error("[subagents] runSingleAgent:ctx-model-provider", { cwd, inheritedProvider });
		const inheritedId = inheritedModel?.id;
		console.error("[subagents] runSingleAgent:ctx-model-id", { cwd, inheritedId });
		inheritedModelLabel = inheritedProvider && inheritedId ? `${inheritedProvider}/${inheritedId}` : undefined;
		console.error("[subagents] runSingleAgent:ctx-model-label", { cwd, inheritedModelLabel });
	} catch (error) {
		console.error("[subagents] runSingleAgent:ctx-model-error", {
			cwd,
			explicitModel: agent.model,
			error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
		});
		throw error;
	}
	console.error("[subagents] runSingleAgent:before-current", { cwd, inheritedModelLabel });
	const current: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		messages: [],
		exitCode: 0,
		usage: defaultUsage(),
		model: agent.model ?? inheritedModelLabel,
		step,
	};
	console.error("[subagents] runSingleAgent:after-current", { cwd, currentModel: current.model });

	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
			details: makeDetails([current]),
		});
	};

	console.error("[subagents] runSingleAgent:before-loader", { cwd });
	const loader = new DefaultResourceLoader({
		cwd,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: () => agent.systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	console.error("[subagents] runSingleAgent:loader-created", { cwd });
	await loader.reload();
	console.error("[subagents] runSingleAgent:loader-reloaded", { cwd });

	let resolvedModel: Model<any> | undefined;
	try {
		console.error("[subagents] runSingleAgent:before-resolveModel", { cwd, explicitModel: agent.model });
		resolvedModel = resolveModel(agent.model, ctx) ?? inheritedModel;
		console.error("[subagents] runSingleAgent:after-resolveModel", {
			cwd,
			model: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : undefined,
		});
	} catch (error) {
		console.error("[subagents] runSingleAgent:resolveModel-error", {
			cwd,
			explicitModel: agent.model,
			error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
		});
		throw error;
	}
	const tools = getToolNames(agent.tools);
	console.error("[subagents] runSingleAgent:before-createAgentSession", {
		cwd,
		tools,
		model: resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : undefined,
	});
	const { session } = await createAgentSession({
		cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
		model: resolvedModel,
		tools,
	});
	console.error("[subagents] runSingleAgent:session-created", { cwd });

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end") {
			current.messages.push(event.message);
			if (event.message.role === "assistant") {
				current.usage.turns += 1;
				const usage = event.message.usage;
				if (usage) {
					current.usage.input += usage.input || 0;
					current.usage.output += usage.output || 0;
					current.usage.cacheRead += usage.cacheRead || 0;
					current.usage.cacheWrite += usage.cacheWrite || 0;
					current.usage.cost += usage.cost?.total || 0;
					current.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!current.model && event.message.model) current.model = event.message.model;
				if (event.message.stopReason) current.stopReason = event.message.stopReason;
				if (event.message.errorMessage) current.errorMessage = event.message.errorMessage;
			}
			emitUpdate();
		}
	});

	const abortHandler = async () => {
		try {
			await session.abort();
		} catch {
			// ignore
		}
	};

	if (signal) {
		if (signal.aborted) await abortHandler();
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		console.error("[subagents] runSingleAgent:before-prompt", { cwd, agentName });
		await session.prompt(task, { source: "extension" });
		console.error("[subagents] runSingleAgent:after-prompt", { cwd, agentName, stopReason: current.stopReason });
		const error = current.stopReason === "error" || current.stopReason === "aborted";
		if (error) current.exitCode = 1;
	} catch (error) {
		console.error("[subagents] runSingleAgent:prompt-error", {
			cwd,
			agentName,
			error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
		});
		current.exitCode = 1;
		current.stderr = (error as Error).message;
	} finally {
		unsubscribe();
		session.dispose();
	}

	return current;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user".',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const ExperimentParams = Type.Object({
	plannerTask: Type.String({ description: "Instruction for the worker agent each iteration" }),
	runCommand: Type.String({ description: "Deterministic command used to evaluate this iteration" }),
	metricRegex: Type.String({ description: "Regex with capture group for metric extraction, e.g. '^val_bpb:\\s*([0-9.]+)'" }),
	objective: StringEnum(["min", "max"] as const, {
		description: "Optimization objective for metric",
		default: "min",
	}),
	mode: Type.Optional(StringEnum(["once", "loop"] as const, { default: "once" })),
	maxIterations: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
	maxDurationMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 })),
	maxNoImprove: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
	targetMetric: Type.Optional(Type.Number({ description: "Stop once this target metric is reached" })),
	workerAgent: Type.Optional(Type.String({ default: "worker" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 5, maximum: 3600, default: 600 })),
	iterationSetupCommand: Type.Optional(Type.String({ description: "Optional command run before each iteration" })),
	onKeepCommand: Type.Optional(Type.String({ description: "Optional command run when metric improves" })),
	onDiscardCommand: Type.Optional(Type.String({ description: "Optional command run when metric does not improve" })),
	resultsFile: Type.Optional(Type.String({ description: "Relative or absolute JSONL results file" })),
});

export default function (pi: ExtensionAPI) {
	const registeredAliasCommands = new Set<string>();
	const reservedCommandNames = new Set(["agent", "agents", "subagent", "experiment_loop"]);

	const runAgentCommand = async (agentName: string, task: string, ctx: any) => {
		if (!task.trim()) {
			ctx.ui.notify(`Usage: /${agentName} <task>`, "error");
			return;
		}

		const discovery = discoverAgents(ctx.cwd, "both");
		const target = discovery.agents.find((a) => a.name === agentName);
		if (!target) {
			ctx.ui.notify(`Unknown agent: ${agentName}. Available: ${formatAgentList(discovery.agents)}`, "error");
			return;
		}

		if (target.source === "project" && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Run project-local agent?",
				`Agent: ${target.name}\nSource: ${target.filePath}\n\nProject agents are repo-controlled prompts. Continue only if trusted.`,
			);
			if (!ok) {
				ctx.ui.notify("Canceled", "info");
				return;
			}
		}

		const startedAt = Date.now();
		if (ctx.hasUI) {
			ctx.ui.notify(`Running ${agentName}...`, "info");
		}

		const result = await runSingleAgent(
			ctx.cwd,
			discovery.agents,
			agentName,
			task,
			ctx.cwd,
			undefined,
			undefined,
			ctx,
			undefined,
			(results) => ({
				mode: "single",
				agentScope: "both",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			}),
		);

		const text = getFinalOutput(result.messages) || result.stderr || "(no output)";
		pi.sendMessage({
			customType: "subagent-command",
			content: `[${agentName}] ${text}`,
			display: true,
			details: { result },
		});

		if (ctx.hasUI) {
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			if (result.exitCode !== 0) {
				ctx.ui.notify(`Agent ${agentName} failed (${seconds}s)`, "error");
			} else {
				ctx.ui.notify(`Agent ${agentName} finished (${seconds}s)`, "info");
			}
		}
	};

	const registerAliasesForCwd = (cwd: string) => {
		const discovery = discoverAgents(cwd, "both");
		const existing = new Set(pi.getCommands().map((c) => c.name));
		for (const agent of discovery.agents) {
			const name = agent.name;
			if (!isValidAgentCommandName(name)) continue;
			if (reservedCommandNames.has(name)) continue;
			if (registeredAliasCommands.has(name)) continue;
			if (existing.has(name)) continue;

			pi.registerCommand(name, {
				description: `Run subagent ${name}`,
				handler: async (args, ctx) => {
					await runAgentCommand(name, args, ctx);
				},
			});
			registeredAliasCommands.add(name);
		}
	};

	pi.registerCommand("agents", {
		description: "List available subagents and their source",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, "both");
			if (discovery.agents.length === 0) {
				ctx.ui.notify("No agents found.", "warning");
				return;
			}
			const lines = discovery.agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`);
			pi.sendMessage({
				customType: "subagent-command",
				content: `Available agents:\n${lines.join("\n")}`,
				display: true,
			});
		},
	});

	pi.registerCommand("agent", {
		description: "Run an agent by name. Usage: /agent <name> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /agent <name> <task>", "error");
				return;
			}
			const spaceIndex = trimmed.indexOf(" ");
			if (spaceIndex < 0) {
				ctx.ui.notify("Usage: /agent <name> <task>", "error");
				return;
			}
			const name = trimmed.slice(0, spaceIndex).trim();
			const task = trimmed.slice(spaceIndex + 1).trim();
			await runAgentCommand(name, task, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		console.error("[subagents] session_start", { cwd: ctx.cwd, hasUI: ctx.hasUI });
		registerAliasesForCwd(ctx.cwd);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate tasks to specialized subagents with isolated in-memory context. Modes: single (agent+task), parallel (tasks), chain (steps with {previous} placeholder).",
		promptSnippet: "Delegate work to named subagents in isolated sessions (single, parallel, or chain modes).",
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			console.error("[subagents] execute entered", {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				params: {
					agent: params.agent,
					task: params.task,
					tasks: params.tasks?.map((t) => ({ agent: t.agent, cwd: t.cwd, taskLength: t.task.length })),
					chain: params.chain?.map((t) => ({ agent: t.agent, cwd: t.cwd, taskLength: t.task.length })),
					cwd: params.cwd,
					agentScope: params.agentScope,
					confirmProjectAgents: params.confirmProjectAgents,
				},
			});
			const agentScope: AgentScope = params.agentScope ?? "user";
			console.error("[subagents] execute before-discoverAgents", { cwd: ctx.cwd, agentScope });
			const discovery = discoverAgents(ctx.cwd, agentScope);
			console.error("[subagents] execute after-discoverAgents", {
				cwd: ctx.cwd,
				agents: discovery.agents.map((a) => ({ name: a.name, source: a.source })),
				projectAgentsDir: discovery.projectAgentsDir,
			});
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: SubagentDetails["mode"]) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode. Available agents: ${formatAgentList(agents)}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgentsRequested.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						ctx,
						onUpdate,
						makeDetails("chain"),
					);
					results.push(result);
					if (result.exitCode !== 0) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}).` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t) =>
					runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, signal, ctx, onUpdate, makeDetails("parallel")),
				);

				const successCount = results.filter((r) => r.exitCode === 0).length;
				return {
					content: [
						{ type: "text", text: `Parallel complete: ${successCount}/${results.length} succeeded.` },
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					ctx,
					onUpdate,
					makeDetails("single"),
				);

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || result.stderr || "(no output)" }],
					details: makeDetails("single")([result]),
					isError: result.exitCode !== 0,
				};
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${formatAgentList(agents)}` }],
				details: makeDetails("single")([]),
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "experiment_loop",
		label: "Experiment Loop",
		description:
			"Run one or more experiment iterations using a worker subagent plus deterministic evaluation command. Loop mode requires explicit stop conditions.",
		promptSnippet: "Run iterative experiments with a worker subagent and evaluate each run via a deterministic metric command.",
		parameters: ExperimentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const mode = params.mode ?? "once";
			const objective = params.objective ?? "min";
			const maxIterations = mode === "once" ? 1 : params.maxIterations;
			const loopConfigError = validateLoopConfig(mode, params);
			if (loopConfigError) {
				return {
					content: [{ type: "text", text: loopConfigError }],
					isError: true,
				};
			}

			const cwd = params.cwd ?? ctx.cwd;
			const timeoutMs = Math.floor((params.timeoutSeconds ?? 600) * 1000);
			const workerAgent = params.workerAgent ?? "worker";
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const startedAt = Date.now();
			const maxDurationMs = params.maxDurationMinutes ? params.maxDurationMinutes * 60_000 : undefined;
			const resultsPath = path.isAbsolute(params.resultsFile ?? "")
				? (params.resultsFile as string)
				: path.join(cwd, params.resultsFile ?? ".pi/experiment-results.jsonl");

			await mkdir(path.dirname(resultsPath), { recursive: true });

			let bestMetric: number | undefined;
			let iterations = 0;
			let noImproveStreak = 0;
			const detailsResults: SingleResult[] = [];

			while (true) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Experiment loop aborted." }], details: { mode: "loop", agentScope, projectAgentsDir: discovery.projectAgentsDir, results: detailsResults, loop: { iterations, bestMetric, objective } } };
				}

				if (maxIterations && iterations >= maxIterations) break;
				if (maxDurationMs && Date.now() - startedAt >= maxDurationMs) break;
				if (params.maxNoImprove && noImproveStreak >= params.maxNoImprove) break;
				if (params.targetMetric !== undefined && bestMetric !== undefined) {
					const met = objective === "min" ? bestMetric <= params.targetMetric : bestMetric >= params.targetMetric;
					if (met) break;
				}

				const iteration = iterations + 1;
				if (params.iterationSetupCommand) {
					await pi.exec("bash", ["-lc", params.iterationSetupCommand], { cwd, signal, timeout: timeoutMs });
				}

				const task = [
					params.plannerTask,
					"",
					`Iteration: ${iteration}`,
					bestMetric === undefined ? "Current best: none" : `Current best: ${bestMetric}`,
					"Apply exactly one experiment change, then stop.",
				].join("\n");

				const agentRun = await runSingleAgent(
					ctx.cwd,
					discovery.agents,
					workerAgent,
					task,
					cwd,
					iteration,
					signal,
					ctx,
					onUpdate,
					(results) => ({
						mode: "loop",
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						loop: { iterations: iteration, bestMetric, objective },
					}),
				);
				detailsResults.push(agentRun);

				const evalResult = await pi.exec("bash", ["-lc", params.runCommand], {
					cwd,
					signal,
					timeout: timeoutMs,
				});

				const output = `${evalResult.stdout}\n${evalResult.stderr}`;
				const metric = parseMetric(output, params.metricRegex);
				const keep = metric !== undefined && improved(objective, metric, bestMetric);
				if (keep && metric !== undefined) {
					bestMetric = metric;
					noImproveStreak = 0;
					if (params.onKeepCommand) {
						await pi.exec("bash", ["-lc", params.onKeepCommand], { cwd, signal, timeout: timeoutMs });
					}
				} else {
					noImproveStreak += 1;
					if (params.onDiscardCommand) {
						await pi.exec("bash", ["-lc", params.onDiscardCommand], { cwd, signal, timeout: timeoutMs });
					}
				}

				const logRecord = {
					ts: new Date().toISOString(),
					iteration,
					metric,
					keep,
					bestMetric,
					exitCode: evalResult.code,
					workerAgent,
				};
				await appendFile(resultsPath, `${JSON.stringify(logRecord)}\n`, "utf8");

				iterations += 1;

				if (onUpdate) {
					onUpdate({
						content: [
							{
								type: "text",
								text: `Iteration ${iteration}: metric=${metric ?? "n/a"} ${keep ? "(improved)" : "(not improved)"}`,
							},
						],
						details: {
							mode: "loop",
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: detailsResults,
							loop: { iterations, bestMetric, objective },
						},
					});
				}

				if (mode === "once") break;
			}

			return {
				content: [
					{
						type: "text",
						text: `Experiment loop finished after ${iterations} iteration(s). Best metric: ${bestMetric ?? "n/a"}. Results: ${resultsPath}`,
					},
				],
				details: {
					mode: "loop",
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: detailsResults,
					loop: { iterations, bestMetric, objective },
				},
			};
		},
	});
}
