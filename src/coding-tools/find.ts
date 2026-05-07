import { glob } from "glob";
import type { AgentTool, ToolResult } from "../tools.js";
import { resolveToCwd } from "./path-utils.js";

export interface FindArgs {
  pattern: string;
  path?: string;
  limit?: number;
}

export function createFindTool(cwd: string): AgentTool {
  return {
    name: "find",
    description:
      "Find files by glob pattern. Pattern is a glob like '**/*.ts' or " +
      "'src/**/test_*.py'. Returns up to `limit` paths (default 200).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Search root (default cwd)" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const { pattern, path, limit = 200 } = args as FindArgs;
      if (signal?.aborted) throw new Error("aborted");
      const root = resolveToCwd(path ?? ".", cwd);
      const matches = await glob(pattern, {
        cwd: root,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        signal,
      });
      const limited = matches.slice(0, limit);
      const trailer =
        matches.length > limit
          ? `\n\n[Showing ${limit} of ${matches.length} matches. Tighten the pattern to narrow.]`
          : "";
      return {
        content: [
          {
            type: "text",
            text: limited.length ? limited.join("\n") + trailer : "(no matches)",
          },
        ],
      };
    },
  };
}
