import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function killTree(pid: number): void {
  // On macOS / Linux we spawned `detached: true`, so the process is its
  // own group leader — kill the whole group with -pid.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

export function createBashTool(cwd: string): AgentTool {
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
    execute: (args, signal): Promise<ToolResult> => {
      const { command, timeout } = args as BashArgs;
      return new Promise<ToolResult>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const child = spawn("bash", ["-lc", command], {
          cwd,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let timedOut = false;
        let killed = false;

        const timeoutHandle = timeout
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) killTree(child.pid);
            }, timeout * 1000)
          : undefined;

        const onAbort = () => {
          killed = true;
          if (child.pid) killTree(child.pid);
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const onData = (b: Buffer) => chunks.push(b);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", async (exitCode) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          const fullOutput = Buffer.concat(chunks).toString("utf-8");
          const truncation = truncateHead(fullOutput);

          let fullOutputPath: string | undefined;
          if (truncation.truncated) {
            const dir = await mkdtemp(join(tmpdir(), "pi-bash-"));
            fullOutputPath = join(dir, "output.txt");
            await writeFile(fullOutputPath, fullOutput, "utf-8");
          }

          let text = truncation.content || "(no output)";
          if (timedOut) text += `\n\n[Command timed out after ${timeout}s]`;
          else if (killed) text += `\n\n[Command aborted]`;
          else if (exitCode !== 0)
            text += `\n\n[Exited with code ${exitCode}]`;

          if (truncation.truncated) {
            text +=
              `\n\n[Truncated: showing ${truncation.outputLines} of ` +
              `${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} ` +
              `of ${formatSize(truncation.totalBytes)}). Full output at ${fullOutputPath}]`;
          }

          const details: BashDetails = {
            truncation: truncation.truncated ? truncation : undefined,
            fullOutputPath,
            exitCode,
          };
          if (timedOut) reject(new Error(`timeout: ${timeout}s`));
          else resolve({ content: [{ type: "text", text }], details });
        });
      });
    },
  };
}
