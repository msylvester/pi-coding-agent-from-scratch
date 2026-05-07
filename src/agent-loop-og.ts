import { streamAnthropic, type ToolDef } from "./provider.js";
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
  tools: ToolDef[];
};

export type AgentLoopConfig = {
  // Hooks added in later phases
};

export async function* runAgentLoop(
  prompts: LlmMessage[],
  context: AgentContext,
  _config: AgentLoopConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, LlmMessage[]> {
  const newMessages: LlmMessage[] = [...prompts];
  context.messages.push(...prompts);

  yield { type: "agent_start" };
  yield { type: "turn_start" };

  for (const prompt of prompts) {
    yield { type: "message_start", message: prompt };
    yield { type: "message_end", message: prompt };
  }

  while (true) {
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

    // Tool execution lives in Phase 4. For now, exit the loop.
    yield { type: "turn_end", message: assistant, toolResults: [] };
    break;
  }

  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* streamAssistant(
  context: AgentContext,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const stream = streamAnthropic(context.systemPrompt, context.messages, context.tools, signal);
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

  if (!finalMessage) throw new Error("Provider stream ended with no final message");
  if (!started) yield { type: "message_start", message: finalMessage };
  yield { type: "message_end", message: finalMessage };
  return finalMessage;
}

