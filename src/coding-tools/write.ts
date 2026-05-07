import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, ToolResult } from "../tools.js";
import { resolveToCwd } from "./path-utils.js";

export interface WriteArgs {
  path: string;
  content: string;
}

export function createWriteTool(cwd: string): AgentTool {
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
      const absolute = resolveToCwd(path, cwd);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf-8");
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
