import { spawn } from "node:child_process";
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

export function createGrepTool(cwd: string): AgentTool {
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
    execute: (args, signal): Promise<ToolResult> => {
      const a = args as GrepArgs;
      const root = resolveToCwd(a.path ?? ".", cwd);
      const limit = a.limit ?? 200;
      const rgArgs: string[] = ["--line-number", "--no-heading", "--color=never"];
      if (a.ignoreCase) rgArgs.push("-i");
      if (a.literal) rgArgs.push("-F");
      if (a.glob) rgArgs.push("-g", a.glob);
      if (a.context !== undefined) rgArgs.push("-C", String(a.context));
      rgArgs.push("--max-count", String(limit));
      rgArgs.push(a.pattern, root);

      return new Promise<ToolResult>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const child = spawn("rg", rgArgs, { cwd });
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (b: Buffer) => chunks.push(b));
        child.stderr?.on("data", (b: Buffer) => chunks.push(b));
        const onAbort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);
          const out = Buffer.concat(chunks).toString("utf-8");
          // ripgrep exits 1 when no matches — treat as empty result, not error
          if (code !== 0 && code !== 1) {
            return reject(new Error(`rg exited ${code}: ${out}`));
          }
          resolve({
            content: [{ type: "text", text: out || "(no matches)" }],
          });
        });
      });
    },
  };
}
