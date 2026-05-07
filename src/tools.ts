import type { TextContent } from "./types.js";

export type ToolResult = { content: TextContent[]; details?: unknown; terminate?: boolean };

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (args: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};

export const getTimeTool: AgentTool = {
  name: "get_time",
  description: "Return the current UTC time.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }),
};

export const addTool: AgentTool = {
  name: "add",
  description: "Add two numbers.",
  input_schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  execute: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { content: [{ type: "text", text: String(a + b) }] };
  },
};
export const notifyDoneTool: AgentTool = {
  name: "notify_done",
  description: "Signal that the agent has completed its task.",
  input_schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  execute: async (args) => {
    const { message } = args as { message: string };
    return {
      content: [{ type: "text", text: `Done: ${message}` }],
      terminate: true,
    };
  },
};
