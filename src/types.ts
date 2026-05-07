export type TextContent = { type: "text"; text: string };

export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultContent = {
  type: "toolResult";
  toolCallId: string;
  content: TextContent[];
  isError?: boolean;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ToolCallContent>;
  stopReason: "stop" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
};

export type UserMessage = {
  role: "user";
  content: TextContent[];
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
};

export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_start"; partial: AssistantMessage }
  | { type: "toolcall_delta"; partial: AssistantMessage }
  | { type: "toolcall_end"; partial: AssistantMessage }
  | { type: "done"; partial: AssistantMessage }
  | { type: "error"; error: Error; partial: AssistantMessage };


export type NotificationMessage = {
  role: "notification";
  text: string;
};

export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type AgentMessage = LlmMessage | NotificationMessage;


