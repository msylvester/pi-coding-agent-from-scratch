import type { ExecutionEnv } from "../harness/env.js";
import type { AgentTool, ToolResult } from "../tools.js";
import { resolveToCwd } from "./path-utils.js";

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createGrepTool(env: ExecutionEnv): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents using ripgrep. Supports literal or regex " +
      "patterns, glob filters, case-insensitive matching, surrounding " +
      "context lines, and a result limit.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Search root (default: cwd)" },
        glob: { type: "string", description: "Glob filter, e.g. '**/*.ts'" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean", description: "Treat pattern as literal" },
        context: { type: "number", description: "Lines of surrounding context" },
        limit: { type: "number", description: "Max matches (default 200)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const a = args as GrepArgs;
      if (signal?.aborted) throw new Error("aborted");

      const root = resolveToCwd(a.path ?? ".", env.cwd);
      const limit = a.limit ?? 200;
      const rgArgs: string[] = ["--line-number", "--no-heading", "--color=never"];
      if (a.ignoreCase) rgArgs.push("-i");
      if (a.literal) rgArgs.push("-F");
      if (a.glob) rgArgs.push("-g", a.glob);
      if (a.context !== undefined) rgArgs.push("-C", String(a.context));
      rgArgs.push("--max-count", String(limit));
      rgArgs.push(a.pattern, root);

      const cmd = ["rg", ...rgArgs.map(shellQuote)].join(" ");
      const { stdout, stderr, exitCode } = await env.exec(cmd, { signal });
      const out = stdout + stderr;

      // ripgrep exits 1 when no matches — treat as empty result, not error
      if (exitCode !== 0 && exitCode !== 1) {
        throw new Error(`rg exited ${exitCode}: ${out}`);
      }

      return {
        content: [{ type: "text", text: out || "(no matches)" }],
      };
    },
  };
}
