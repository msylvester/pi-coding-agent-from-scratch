import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, AssistantStreamEvent, LlmMessage } from "./types.js";

const client = new Anthropic();

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export async function* streamAnthropic(
  systemPrompt: string,
  messages: LlmMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): AsyncGenerator<AssistantStreamEvent, AssistantMessage> {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    stopReason: "stop",
  };

  yield { type: "start", partial };

  // Translate our LlmMessage[] to Anthropic's MessageParam[]
  const apiMessages = messages.map(toApiMessage);

  try {


  const response = await client.messages.stream(
    {
      model: "claude-haiku-4-5",
      max_tokens: 8192,           // was 1024
      system: systemPrompt,
      messages: apiMessages,
      tools: tools.length ? tools : undefined,
    },
    { signal },
  );
    let toolJsonBuf = "";
    let currentBlockIndex = -1;

    for await (const event of response) {
      if (event.type === "content_block_start") {
        currentBlockIndex = event.index;
        if (event.content_block.type === "text") {
          partial.content.push({ type: "text", text: "" });
        } else if (event.content_block.type === "tool_use") {
          toolJsonBuf = "";
          partial.content.push({
            type: "toolCall",
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: {},
          });
          yield { type: "toolcall_start", partial };
        }
      } else if (event.type === "content_block_delta") {
        const block = partial.content[currentBlockIndex];
        if (event.delta.type === "text_delta" && block.type === "text") {
          block.text += event.delta.text;
          yield { type: "text_delta", delta: event.delta.text, partial };
        } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
          toolJsonBuf += event.delta.partial_json;
          yield { type: "toolcall_delta", partial };
        }
      } else if (event.type === "content_block_stop") {
        const block = partial.content[currentBlockIndex];
        if (block.type === "toolCall") {
          block.arguments = toolJsonBuf ? JSON.parse(toolJsonBuf) : {};
          yield { type: "toolcall_end", partial };
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason === "tool_use") partial.stopReason = "tool_use";
        else if (event.delta.stop_reason === "end_turn") partial.stopReason = "stop";
      }
    }

    yield { type: "done", partial };
    return partial;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    partial.stopReason = signal?.aborted ? "aborted" : "error";
    partial.errorMessage = error.message;
    yield { type: "error", error, partial };
    return partial;
  }
}

function toApiMessage(m: LlmMessage): Anthropic.MessageParam {
  if (m.role === "user") {
    return { role: "user", content: m.content.map((c) => ({ type: "text", text: c.text })) };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content.map((c) =>
        c.type === "text"
          ? { type: "text" as const, text: c.text }
          : { type: "tool_use" as const, id: c.id, name: c.name, input: c.arguments },
      ),
    };
  }
  // toolResult role becomes a user message containing tool_result blocks
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        is_error: m.isError,
        content: m.content.map((c) => ({ type: "text" as const, text: c.text })),
      },
    ],
  };
}
