import type { ExecutionEnv } from "../harness/env.js";
import type { AgentTool, ToolResult } from "../tools.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

export interface BashArgs {
  command: string;
  timeout?: number; // seconds
}

export interface BashDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  exitCode: number | null;
}

export function createBashTool(env: ExecutionEnv): AgentTool {
  return {
    name: "bash",
    description:
      `Execute a bash command in cwd. Returns stdout+stderr. Output is ` +
      `truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. ` +
      `If truncated, the full output is written to a temp file referenced ` +
      `in the result. Optional timeout in seconds.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const { command, timeout } = args as BashArgs;
      if (signal?.aborted) throw new Error("aborted");

      let timedOut = false;
      const innerController = new AbortController();
      const timeoutHandle = timeout
        ? setTimeout(() => {
            timedOut = true;
            innerController.abort();
          }, timeout * 1000)
        : undefined;
      const onOuterAbort = () => innerController.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      let result;
      try {
        result = await env.exec(command, { signal: innerController.signal });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onOuterAbort);
      }

      if (timedOut) throw new Error(`timeout: ${timeout}s`);

      const fullOutput = result.stdout + result.stderr;
      const truncation = truncateHead(fullOutput);

      let fullOutputPath: string | undefined;
      if (truncation.truncated) {
        fullOutputPath = await env.createTempFile({
          prefix: "pi-bash-",
          suffix: ".txt",
        });
        await env.writeFile(fullOutputPath, fullOutput);
      }

      const aborted = signal?.aborted ?? false;
      let text = truncation.content || "(no output)";
      if (aborted) text += `\n\n[Command aborted]`;
      else if (result.exitCode !== 0)
        text += `\n\n[Exited with code ${result.exitCode}]`;

      if (truncation.truncated) {
        text +=
          `\n\n[Truncated: showing ${truncation.outputLines} of ` +
          `${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} ` +
          `of ${formatSize(truncation.totalBytes)}). Full output at ${fullOutputPath}]`;
      }

      const details: BashDetails = {
        truncation: truncation.truncated ? truncation : undefined,
        fullOutputPath,
        exitCode: result.exitCode,
      };
      return { content: [{ type: "text", text }], details };
    },
  };
}
