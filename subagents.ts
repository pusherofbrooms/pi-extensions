import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Message, Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	truncateHead,
	getAgentDir,
	parseFrontmatter,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { getFinalAssistantText, defaultAgentRunUsage, runAgentSession, type AgentThinkingLevel } from "./agent-runner.ts";
import { Type } from "typebox";

export type AgentScope = "user" | "project" | "both";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: unknown;
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
	sessionFile?: string;
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
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
	return defaultAgentRunUsage();
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
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
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

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		const tools = typeof frontmatter.tools === "string" ? frontmatter.tools
			.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean) : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: frontmatter.thinking,
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

function discoverAgents(cwd: string, scope: AgentScope, projectTrusted = false): { agents: AgentConfig[]; projectAgentsDir: string | null } {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = projectTrusted ? findNearestProjectAgentsDir(cwd) : null;

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

function isParallelFailure(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

async function formatParallelResult(result: SingleResult, index: number): Promise<string> {
	const failed = isParallelFailure(result);
	const status = failed ? `failed (exit ${result.exitCode}${result.stopReason ? `, ${result.stopReason}` : ""})` : "completed";
	const output = getFinalAssistantText(result.messages);
	const diagnostics = failed ? [...new Set([result.errorMessage, result.stderr].filter(Boolean))].join("\n") : "";
	const body = [diagnostics, output].filter(Boolean).join("\n\n") || "(no output)";
	// Truncate each task independently so later tasks are never dropped.
	const truncated = truncateHead(body);
	let text = truncated.content;
	if (truncated.truncated) {
		const dir = await fs.promises.mkdtemp(path.join(tmpdir(), "pi-subagent-output-"));
		const file = path.join(dir, "output.txt");
		await fs.promises.writeFile(file, body, { encoding: "utf8", mode: 0o600 });
		text += `\n\n[Output truncated to 2000 lines or 50 KB. Full output saved to: ${file}]`;
	}
	return `### Task ${index + 1}: [${result.agent}] ${status}\n\n${text}`;
}

export function parseThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Invalid agent thinking level '${String(value)}'. Expected off, minimal, low, medium, high, xhigh, or max.`);
	}
	const normalized = value.trim().toLowerCase();
	if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) {
		return normalized as AgentThinkingLevel;
	}
	throw new Error(`Invalid agent thinking level '${value}'. Expected off, minimal, low, medium, high, xhigh, or max.`);
}

type ToolExecute = Parameters<ExtensionAPI["registerTool"]>[0]["execute"];
type ToolContext = Parameters<ToolExecute>[4];
type ToolOnUpdate = Parameters<ToolExecute>[3];

function resolveModel(spec: string | undefined, ctx: ToolContext): Model<any> | undefined {
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

export interface AgentCapability {
	name: string;
	description: string;
	tools: string[];
	source: "user" | "project" | "default";
}

export function enumerateAgentCapabilities(cwd: string, scope: AgentScope = "user", projectTrusted = false): AgentCapability[] {
	return discoverAgents(cwd, scope, projectTrusted).agents.map((agent) => ({
		name: agent.name,
		description: agent.description,
		tools: getToolNames(agent.tools),
		source: agent.source,
	}));
}

export function formatAgentCapabilities(capabilities: AgentCapability[]): string {
	if (capabilities.length === 0) return "Available agents: none.";
	return [
		"Available agents (use only these exact names and assign tasks compatible with their tools):",
		...capabilities.map(
			(agent) => `- ${agent.name} (${agent.source}) — ${agent.description}; tools: ${agent.tools.join(", ")}`,
		),
	].join("\n");
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
	ctx: ToolContext,
	onUpdate: ToolOnUpdate,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	parentThinkingLevel: AgentThinkingLevel,
): Promise<SingleResult> {
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

	const cwd = runCwd ? path.resolve(defaultCwd, runCwd) : defaultCwd;
	const inheritedModel = ctx.model;
	const inheritedProvider = inheritedModel?.provider;
	const inheritedId = inheritedModel?.id;
	const inheritedModelLabel = inheritedProvider && inheritedId ? `${inheritedProvider}/${inheritedId}` : undefined;
	const resolvedModel = resolveModel(agent.model, ctx) ?? inheritedModel;
	const tools = getToolNames(agent.tools);
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
	let thinkingLevel: AgentThinkingLevel;
	try {
		thinkingLevel = parseThinkingLevel(agent.thinking) ?? parentThinkingLevel;
		current.thinkingLevel = thinkingLevel;
	} catch (error) {
		return { ...current, exitCode: 1, stderr: (error as Error).message };
	}

	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
			details: makeDetails([current]),
		});
	};

	const result = await runAgentSession({
		cwd,
		systemPrompt: agent.systemPrompt,
		prompt: task,
		tools,
		model: resolvedModel,
		thinkingLevel,
		signal,
		onMessageEnd: (partial) => {
			current.messages = partial.messages;
			current.exitCode = partial.exitCode;
			current.stderr = partial.stderr;
			current.usage = partial.usage;
			current.sessionFile = partial.sessionFile;
			current.model = partial.model ?? current.model;
			current.stopReason = partial.stopReason;
			current.errorMessage = partial.errorMessage;
			emitUpdate();
		},
	});

	current.messages = result.messages;
	current.exitCode = result.exitCode;
	current.stderr = result.stderr;
	current.usage = result.usage;
	current.sessionFile = result.sessionFile;
	current.model = result.model ?? current.model;
	current.stopReason = result.stopReason;
	current.errorMessage = result.errorMessage;
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

export default function (pi: ExtensionAPI) {
	const registeredAliasCommands = new Set<string>();
	// Extension initialization has no trusted project context, so never inspect project agents here.
	const agentCapabilityDescription = formatAgentCapabilities(enumerateAgentCapabilities(process.cwd(), "user"));
	const reservedCommandNames = new Set(["agent", "agents", "subagent"]);
	const isProjectTrusted = (ctx: any): boolean =>
		typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;

	const runAgentCommand = async (agentName: string, task: string, ctx: any) => {
		if (!task.trim()) {
			ctx.ui.notify(`Usage: /${agentName} <task>`, "error");
			return;
		}

		const discovery = discoverAgents(ctx.cwd, "both", isProjectTrusted(ctx));
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
			pi.getThinkingLevel(),
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

	const registerAliasesForCwd = (cwd: string, projectTrusted: boolean) => {
		const discovery = discoverAgents(cwd, "both", projectTrusted);
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
			const discovery = discoverAgents(ctx.cwd, "both", isProjectTrusted(ctx));
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
		registerAliasesForCwd(ctx.cwd, isProjectTrusted(ctx));
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated in-memory context. Modes: single (agent+task), parallel (tasks), chain (steps with {previous} placeholder).",
			"Parallel outputs include per-task findings and diagnostics, capped at 2000 lines or 50 KB per task; full truncated output is saved to a temporary file.",
			agentCapabilityDescription,
		].join("\n\n"),
		promptSnippet: `Delegate work to named subagents in isolated sessions (single, parallel, or chain modes).\n${agentCapabilityDescription}`,
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parentThinkingLevel = pi.getThinkingLevel();
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope, isProjectTrusted(ctx));
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
						parentThinkingLevel,
					);
					results.push(result);
					if (result.exitCode !== 0) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}).` }],
							details: makeDetails("chain")(results),
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
					};
				}

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t) =>
					runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, signal, ctx, onUpdate, makeDetails("parallel"), parentThinkingLevel),
				);

				const successCount = results.filter((r) => !isParallelFailure(r)).length;
				const summaries = await Promise.all(results.map(formatParallelResult));
				return {
					content: [
						{ type: "text", text: `Parallel complete: ${successCount}/${results.length} succeeded.\n\n${summaries.join("\n\n---\n\n")}` },
					],
					details: makeDetails("parallel")(results),
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
					parentThinkingLevel,
				);

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || result.stderr || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${formatAgentList(agents)}` }],
				details: makeDetails("single")([]),
			};
		},
	});

}
