import type { ExecutionEnv } from "../harness/env.js";
import type { AgentTool, ToolResult } from "../tools.js";

export interface WriteArgs {
  path: string;
  content: string;
}

export function createWriteTool(env: ExecutionEnv): AgentTool {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file if missing, overwrites " +
      "if present. Creates parent directories automatically.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const { path, content } = args as WriteArgs;
      if (signal?.aborted) throw new Error("aborted");
      await env.writeFile(path, content);
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${content.length} bytes to ${path}`,
          },
        ],
      };
    },
  };
}
