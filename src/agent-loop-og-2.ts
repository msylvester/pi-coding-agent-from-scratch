import { streamAnthropic } from "./provider.js";
import type { AgentTool, ToolResult } from "./tools.js";
import type {
  AssistantMessage,
  AssistantStreamEvent,
  LlmMessage,
  ToolResultMessage,
} from "./types.js";

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: LlmMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: LlmMessage }
  | { type: "message_update"; message: AssistantMessage; assistantEvent: AssistantStreamEvent }
  | { type: "message_end"; message: LlmMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage };

export type AgentContext = {
  systemPrompt: string;
  messages: LlmMessage[];
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
};

export async function* runAgentLoop(
  prompts: LlmMessage[],
  context: AgentContext,
  config: AgentLoopConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, LlmMessage[]> {
  const newMessages: LlmMessage[] = [...prompts];
  context.messages.push(...prompts);

  yield { type: "agent_start" };
  yield { type: "turn_start" };
  for (const p of prompts) {
    yield { type: "message_start", message: p };
    yield { type: "message_end", message: p };
  }

  let firstTurn = true;

  while (true) {
    if (!firstTurn) yield { type: "turn_start" };
    firstTurn = false;

    const assistant = yield* streamAssistant(context, signal);
    context.messages.push(assistant);
    newMessages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length === 0) {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    const toolResults: ToolResultMessage[] = [];
    let terminateAll = true;

    for (const tc of toolCalls) {
      yield { type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments };

      const tool = context.tools.find((t) => t.name === tc.name);
      let result: ToolResult;
      let isError = false;

      if (!tool) {
        result = { content: [{ type: "text", text: `Tool ${tc.name} not found` }] };
        isError = true;
      } else {
        const before = await config.beforeToolCall?.({
          toolCall: { id: tc.id, name: tc.name, args: tc.arguments },
        });
        if (before?.block) {
          result = { content: [{ type: "text", text: before.reason ?? "Tool blocked" }] };
          isError = true;
        } else {
          try {
            result = await tool.execute(tc.arguments, signal);
          } catch (err) {
            result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
            isError = true;
          }
          const after = await config.afterToolCall?.({
            toolCall: { id: tc.id, name: tc.name, args: tc.arguments },
            result,
            isError,
          });
          if (after) {
            result = {
              content: after.content ?? result.content,
              details: after.details ?? result.details,
              terminate: after.terminate ?? result.terminate,
            };
            if (after.isError !== undefined) isError = after.isError;
          }
        }
      }

      if (!result.terminate) terminateAll = false;

      const trMessage: ToolResultMessage = {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError,
      };

      yield { type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: trMessage };
      yield { type: "message_start", message: trMessage };
      yield { type: "message_end", message: trMessage };

      context.messages.push(trMessage);
      newMessages.push(trMessage);
      toolResults.push(trMessage);
    }

    yield { type: "turn_end", message: assistant, toolResults };

    if (terminateAll) break; // every result asked to stop
  }

  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* streamAssistant(
  context: AgentContext,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const tools = context.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const stream = streamAnthropic(context.systemPrompt, context.messages, tools, signal);
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
