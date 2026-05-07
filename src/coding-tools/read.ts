import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { AgentTool, ToolResult } from "../tools.js";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp",
  ".css", ".html", ".yaml", ".yml", ".toml", ".sh", ".sql",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface ReadDetails {
  truncation?: TruncationResult;
}

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export function createReadTool(cwd: string): AgentTool {
  return {
    name: "read",
    description:
      `Read a file. Output is truncated to 2000 lines or 50KB ` +
      `(whichever hits first). Use offset (1-indexed) and limit to ` +
      `page through large files.`,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path (relative or absolute)" },
        offset: { type: "number", description: "1-indexed start line" },
        limit: { type: "number", description: "Max lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const { path, offset, limit } = args as ReadArgs;
      const absolute = resolveToCwd(path, cwd);

      if (signal?.aborted) throw new Error("aborted");
      await access(absolute, constants.R_OK);

      const ext = absolute.slice(absolute.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        return {
          content: [
            {
              type: "text",
              text: `[image omitted: ${path} — image input not enabled in this build]`,
            },
          ],
        };
      }

      const buffer = await readFile(absolute);
      const text = buffer.toString("utf-8");
      const allLines = text.split("\n");
      const totalLines = allLines.length;

      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(
          `Offset ${offset} is beyond end of file (${allLines.length} lines)`,
        );
      }

      const slice =
        limit !== undefined
          ? allLines.slice(startLine, startLine + limit)
          : allLines.slice(startLine);
      const selected = slice.join("\n");

      const truncation = truncateHead(selected);
      let outputText: string;
      let details: ReadDetails | undefined;

      if (truncation.firstLineExceedsLimit) {
        const lineSize = formatSize(
          Buffer.byteLength(allLines[startLine] ?? "", "utf-8"),
        );
        outputText =
          `[Line ${startLine + 1} is ${lineSize}, exceeds ` +
          `${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash with sed/head.]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const start = startLine + 1;
        const end = startLine + truncation.outputLines;
        outputText =
          truncation.content +
          `\n\n[Showing lines ${start}-${end} of ${totalLines}. ` +
          `Use offset=${end + 1} to continue.]`;
        details = { truncation };
      } else {
        outputText = truncation.content;
      }

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
  };
}
