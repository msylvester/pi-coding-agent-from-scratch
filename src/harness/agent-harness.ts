import { Agent } from "../agent.js";
import type { AgentTool, ToolResult } from "../tools.js";
import type { AgentEvent, AgentMessage } from "../types.js";
import {
  estimateContextTokens,
  findCutPoint,
  generateSummary,
} from "./compaction.js";
import type { ExecutionEnv } from "./env.js";
import type { Session } from "./session.js";
import { formatPromptTemplateInvocation } from "./prompt-templates.js";
import { formatSkillInvocation, formatSkillsForSystemPrompt } from "./skills.js";

const KEEP_RECENT_TOKENS = 20_000;
const AUTO_COMPACT_THRESHOLD = 180_000;
import type {
  AgentHarnessEventResultMap,
  AgentHarnessOptions,
  AgentHarnessOwnEvent,
  AgentHarnessResources,
  Skill,
} from "./types.js";

type AnyEvent = AgentEvent | AgentHarnessOwnEvent;

export class AgentHarness {
  readonly agent: Agent;
  readonly env: ExecutionEnv;
  private session: Session;
  private model: AgentHarnessOptions["model"];
  private apiKey: string;
  private resources: AgentHarnessResources;
  private tools = new Map<string, AgentTool>();
  private activeToolNames: string[];
  private systemPrompt: AgentHarnessOptions["systemPrompt"];
  private phase: "idle" | "turn" | "compaction" = "idle";
  private listeners = new Set<(event: AnyEvent) => Promise<void> | void>();
  private hooks = new Map<keyof AgentHarnessEventResultMap, Set<(event: any) => Promise<any> | any>>();
  private pendingMessages: AgentMessage[] = [];

  constructor(options: AgentHarnessOptions) {
    this.env = options.env;
    this.session = options.session;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.resources = options.resources ?? {};
    this.systemPrompt = options.systemPrompt;
    for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);
    this.activeToolNames = [...this.tools.keys()];

    this.agent = new Agent({
      systemPrompt: "",  // filled by prepareNextTurn
      tools: [...this.tools.values()],
    });

    // Edge 1: rebuild context from the session before each turn.
    this.agent.prepareNextTurn = async () => {
      const ctx = await this.session.buildContext();
      const activeTools = this.activeToolNames
        .map((n) => this.tools.get(n))
        .filter((t): t is AgentTool => !!t);
      const sysPrompt = await this.resolveSystemPrompt(activeTools);
      return {
        context: { systemPrompt: sysPrompt, messages: ctx.messages, tools: activeTools },
        model: this.model,
      };
    };

    // Edge 2: let hooks rewrite the context just before the provider call.
    this.agent.transformContext = async (messages) => {
      const patched = await this.emitHook({ type: "context", messages: [...messages] });
      const effective = patched?.messages ?? messages;
      if (
        estimateContextTokens(effective) > AUTO_COMPACT_THRESHOLD &&
        this.phase !== "compaction"
      ) {
        queueMicrotask(() => { void this.compact().catch(() => {}); });
      }
      return effective;
    };

    // Edge 3: let hooks veto a tool call.
    this.agent.beforeToolCall = async ({ toolCall, args }) => {
      const result = await this.emitHook({
        type: "tool_call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: args as Record<string, unknown>,
      });
      return result ? { block: result.block, reason: result.reason } : undefined;
    };

    // Edge 4: let hooks rewrite a tool result.
    this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
      const patch = await this.emitHook({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: args as Record<string, unknown>,
        content: result.content,
        isError,
      });
      return patch
        ? { content: patch.content, isError: patch.isError, terminate: patch.terminate }
        : undefined;
    };

    // Edge 5: persist messages, emit own events.
    this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  private async resolveSystemPrompt(activeTools: AgentTool[]): Promise<string> {
    let prompt: string;
    if (typeof this.systemPrompt === "string") {
      prompt = this.systemPrompt;
    } else if (typeof this.systemPrompt === "function") {
      prompt = await this.systemPrompt({
        env: this.env,
        session: this.session,
        model: this.model,
        activeTools,
        resources: this.resources,
      });
    } else {
      prompt = "You are a helpful assistant.";
    }
    const skillsBlock = formatSkillsForSystemPrompt(this.resources.skills ?? []);
    return skillsBlock ? `${prompt}\n\n${skillsBlock}` : prompt;
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    // Fan out to subscribers.
    for (const listener of this.listeners) await listener(event);

    if (event.type === "message_end") {
      // Persist every message as it's finalized.
      if (this.phase === "idle") {
        await this.session.appendMessage(event.message);
      } else {
        // During a turn, the harness will flush at turn_end.
        this.pendingMessages.push(event.message);
      }
    }

    if (event.type === "turn_end") {
      const hadPendingMutations = this.pendingMessages.length > 0;
      const toFlush = this.pendingMessages;
      this.pendingMessages = [];
      for (const message of toFlush) {
        await this.session.appendMessage(message);
      }
      for (const toolResult of event.toolResults) {
        await this.session.appendMessage(toolResult);
      }
      await this.emitOwn({ type: "save_point", hadPendingMutations });
    }

    if (event.type === "agent_end") {
      this.phase = "idle";
      await this.emitOwn({ type: "settled" });
    }
  }

  private async emitOwn(event: AgentHarnessOwnEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  private async emitHook<T extends keyof AgentHarnessEventResultMap>(
    event: Extract<AgentHarnessOwnEvent, { type: T }>,
  ): Promise<AgentHarnessEventResultMap[T] | undefined> {
    const handlers = this.hooks.get(event.type as T);
    if (!handlers || handlers.size === 0) return undefined;
    let last: AgentHarnessEventResultMap[T] | undefined;
    for (const handler of handlers) {
      const result = await handler(event);
      if (result !== undefined) last = result;
    }
    return last;
  }

  // Public API ----------------------------------------------------------

  async prompt(text: string): Promise<void> {
    if (this.phase !== "idle") throw new Error("AgentHarness is busy");
    this.phase = "turn";
    const activeTools = this.activeToolNames
      .map((n) => this.tools.get(n))
      .filter((t): t is AgentTool => !!t);
    const ctx = await this.session.buildContext();
    this.agent.systemPrompt = await this.resolveSystemPrompt(activeTools);
    this.agent.tools = activeTools;
    this.agent.messages = [...ctx.messages];
    try {
      await this.agent.prompt(text);
    } finally {
      // safety: phase reset happens on agent_end too
      this.phase = "idle";
    }
  }

  subscribe(listener: (event: AnyEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  on<T extends keyof AgentHarnessEventResultMap>(
    type: T,
    handler: (event: Extract<AgentHarnessOwnEvent, { type: T }>) =>
      Promise<AgentHarnessEventResultMap[T]> | AgentHarnessEventResultMap[T],
  ): () => void {
    let handlers = this.hooks.get(type);
    if (!handlers) { handlers = new Set(); this.hooks.set(type, handlers); }
    handlers.add(handler as any);
    return () => handlers!.delete(handler as any);
  }

  abort(): Promise<void> {
    this.agent.abort();
    return this.agent.waitForIdle();
  }

  async setModel(model: AgentHarnessOptions["model"]): Promise<void> {
    this.model = model;
    await this.session.appendModelChange(model.provider, model.id);
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    const missing = toolNames.filter((n) => !this.tools.has(n));
    if (missing.length) throw new Error(`Unknown tools: ${missing.join(", ")}`);
    this.activeToolNames = [...toolNames];
  }

  async skill(name: string, extra?: string): Promise<void> {
    const skill = (this.resources.skills ?? []).find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    await this.prompt(formatSkillInvocation(skill, extra));
  }

  async promptFromTemplate(name: string, args: string[] = []): Promise<void> {
    const template = (this.resources.promptTemplates ?? []).find((t) => t.name === name);
    if (!template) throw new Error(`Unknown prompt template: ${name}`);
    await this.prompt(formatPromptTemplateInvocation(template, args));
  }

  async compact(): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }> {
    if (this.phase !== "idle") throw new Error("compact() requires idle harness");
    this.phase = "compaction";
    try {
      const entries = await this.session.getBranch();
      const context = await this.session.buildContext();
      const tokensBefore = estimateContextTokens(context.messages);

      const cut = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);
      const messagesToSummarize: AgentMessage[] = [];
      for (let i = 0; i < cut.firstKeptEntryIndex; i++) {
        const entry = entries[i];
        if (entry.type === "message") messagesToSummarize.push(entry.message);
      }
      if (messagesToSummarize.length === 0) {
        return { summary: "", firstKeptEntryId: entries[0]?.id ?? "", tokensBefore };
      }
      const summary = await generateSummary(messagesToSummarize, this.model, this.apiKey);
      const firstKeptEntryId = entries[cut.firstKeptEntryIndex].id;
      await this.session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
      return { summary, firstKeptEntryId, tokensBefore };
    } finally {
      this.phase = "idle";
    }
  }
}
