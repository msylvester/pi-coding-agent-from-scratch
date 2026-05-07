import { streamAnthropic } from "./provider.js";
import type { AgentTool, ToolResult } from "./tools.js";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  LlmMessage,
  ToolCallContent,
  ToolResultMessage,
} from "./types.js";

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage; assistantEvent: AssistantStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage };

export type AgentContext = {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
};

export type BeforeToolCall = (ctx: {
  toolCall: { id: string; name: string; args: unknown };
}) => Promise<{ block?: boolean; reason?: string } | undefined>;

export type AfterToolCall = (ctx: {
  toolCall: { id: string; name: string; args: unknown };
  result: ToolResult;
  isError: boolean;
}) => Promise<Partial<ToolResult> & { isError?: boolean } | undefined>;

export type AgentLoopConfig = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  convertToLlm?: (messages: AgentMessage[]) => LlmMessage[] | Promise<LlmMessage[]>;
};

export const defaultConvertToLlm = (messages: AgentMessage[]): LlmMessage[] =>
  messages.filter((m): m is LlmMessage => m.role !== "notification");

export async function* runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  context.messages.push(...prompts);

  yield { type: "agent_start" };
  yield { type: "turn_start" };
  for (const p of prompts) {
    yield { type: "message_start", message: p };
    yield { type: "message_end", message: p };
  }

  let firstTurn = true;

  let pending: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreTools = true;

    while (hasMoreTools || pending.length > 0) {
      if (!firstTurn) yield { type: "turn_start" };
      firstTurn = false;

      for (const msg of pending) {
        yield { type: "message_start", message: msg };
        yield { type: "message_end", message: msg };
        context.messages.push(msg);
        newMessages.push(msg);
      }
      pending = [];

      const assistant = yield* streamAssistant(context, config, signal);
      context.messages.push(assistant);
      newMessages.push(assistant);

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        yield { type: "turn_end", message: assistant, toolResults: [] };
        yield { type: "agent_end", messages: newMessages };
        return newMessages;
      }

      const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
      let toolResults: ToolResultMessage[] = [];
      hasMoreTools = false;

      if (toolCalls.length > 0) {
        const exec = yield* executeTools(toolCalls, context, config, signal);
        toolResults = exec.results;
        hasMoreTools = !exec.terminate;
        for (const r of toolResults) {
          context.messages.push(r);
          newMessages.push(r);
        }
      }

      yield { type: "turn_end", message: assistant, toolResults };

      pending = (await config.getSteeringMessages?.()) ?? [];
    }

    const followUps = (await config.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      pending = followUps;
      continue;
    }
    break;
  }

  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* streamAssistant(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const tools = context.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const convert = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = await convert(context.messages);
  const stream = streamAnthropic(context.systemPrompt, llmMessages, tools, signal);
  let started = false;
  let finalMessage: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === "start") {
      started = true;
      yield { type: "message_start", message: event.partial };
    } else if (event.type === "done" || event.type === "error") {
      finalMessage = event.partial;
    } else {
      yield { type: "message_update", message: event.partial, assistantEvent: event };
    }
  }

  if (!finalMessage) throw new Error("No final message");
  if (!started) yield { type: "message_start", message: finalMessage };
  yield { type: "message_end", message: finalMessage };
  return finalMessage;
}

async function* executeTools(
  toolCalls: ToolCallContent[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, { results: ToolResultMessage[]; terminate: boolean }> {
  const results: ToolResultMessage[] = [];
  let terminate = false;

  for (const call of toolCalls) {
    const toolCall = { id: call.id, name: call.name, args: call.arguments };

    const before = await config.beforeToolCall?.({ toolCall });
    if (before?.block) {
      const blocked: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: before.reason ?? "Blocked." }],
        isError: true,
      };
      yield { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments };
      yield { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: blocked };
      results.push(blocked);
      continue;
    }

    yield { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments };

    const tool = context.tools.find((t) => t.name === call.name);
    let raw: ToolResult;
    let isError = false;
    if (!tool) {
      raw = { content: [{ type: "text", text: `Unknown tool: ${call.name}` }] };
      isError = true;
    } else {
      try {
        raw = await tool.execute(call.arguments, signal);
      } catch (err) {
        raw = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
        isError = true;
      }
    }

    const after = await config.afterToolCall?.({ toolCall, result: raw, isError });
    const finalContent = after?.content ?? raw.content;
    const finalTerminate = after?.terminate ?? raw.terminate ?? false;
    const finalIsError = after?.isError ?? isError;

    const resultMsg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: finalContent,
      isError: finalIsError,
    };

    yield { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: resultMsg };
    results.push(resultMsg);
    if (finalTerminate) terminate = true;
  }

  return { results, terminate };
}
