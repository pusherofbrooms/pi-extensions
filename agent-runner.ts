import type { Message, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

export interface AgentRunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface AgentRunResult {
  messages: Message[];
  finalText: string;
  sessionFile?: string;
  usage: AgentRunUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  exitCode: number;
  stderr?: string;
}

export interface RunAgentSessionOptions {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  tools: string[];
  model?: Model<any>;
  agentDir?: string;
  persistSession?: boolean;
  signal?: AbortSignal;
  onMessageEnd?: (result: AgentRunResult, message: Message) => void;
  inlineExtensions?: InlineExtension[];
}

export function defaultAgentRunUsage(): AgentRunUsage {
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

export function getFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

export async function runAgentSession(options: RunAgentSessionOptions): Promise<AgentRunResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: options.inlineExtensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const result: AgentRunResult = {
    messages: [],
    finalText: "",
    usage: defaultAgentRunUsage(),
    exitCode: 0,
  };

  const sessionManager = options.persistSession === false
    ? SessionManager.inMemory(options.cwd)
    : SessionManager.create(options.cwd);

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager,
    model: options.model,
    tools: options.tools,
  });
  result.sessionFile = session.sessionFile;

  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end") return;
    result.messages.push(event.message);
    result.finalText = getFinalAssistantText(result.messages);

    if (event.message.role === "assistant") {
      result.usage.turns += 1;
      const usage = event.message.usage;
      if (usage) {
        result.usage.input += usage.input || 0;
        result.usage.output += usage.output || 0;
        result.usage.cacheRead += usage.cacheRead || 0;
        result.usage.cacheWrite += usage.cacheWrite || 0;
        result.usage.cost += usage.cost?.total || 0;
        result.usage.contextTokens = usage.totalTokens || 0;
      }
      if (!result.model && event.message.model) result.model = event.message.model;
      if (event.message.stopReason) result.stopReason = event.message.stopReason;
      if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
    }

    options.onMessageEnd?.(result, event.message);
  });

  const abortHandler = async () => {
    try {
      await session.abort();
    } catch {
      // ignore abort cleanup errors
    }
  };

  if (options.signal) {
    if (options.signal.aborted) await abortHandler();
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await session.prompt(options.prompt, { source: "extension" });
    if (result.stopReason === "error" || result.stopReason === "aborted") result.exitCode = 1;
  } catch (error) {
    result.exitCode = 1;
    result.stderr = (error as Error).message;
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", abortHandler);
    session.dispose();
  }

  result.finalText = getFinalAssistantText(result.messages);
  return result;
}
