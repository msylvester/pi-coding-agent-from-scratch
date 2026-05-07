import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool, ToolResult } from "../tools.js";
import { resolveToCwd } from "./path-utils.js";

export interface EditOp {
  oldText: string;
  newText: string;
}

export interface EditArgs {
  path: string;
  edits: EditOp[];
}

export interface EditDetails {
  diff: string;
}

function applyEdit(content: string, edit: EditOp, path: string): string {
  if (edit.oldText === "") {
    throw new Error(`edit on ${path}: oldText must be non-empty`);
  }
  const first = content.indexOf(edit.oldText);
  if (first === -1) {
    throw new Error(
      `edit on ${path}: oldText not found. ` +
        `Read the file first to confirm the exact bytes you intend to replace.`,
    );
  }
  const second = content.indexOf(edit.oldText, first + 1);
  if (second !== -1) {
    throw new Error(
      `edit on ${path}: oldText matches multiple locations. ` +
        `Add surrounding lines until the snippet is unique.`,
    );
  }
  return (
    content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length)
  );
}

function makeDiff(before: string, after: string, path: string): string {
  // Tiny line-based diff — not pi-mono's full unified diff, but enough
  // for a tutorial. Shows added/removed lines with leading +/-.
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i] ?? ""}`);
      i++;
      j++;
    } else if (j < b.length && !a.includes(b[j] ?? "", i)) {
      out.push(`+ ${b[j] ?? ""}`);
      j++;
    } else if (i < a.length && !b.includes(a[i] ?? "", j)) {
      out.push(`- ${a[i] ?? ""}`);
      i++;
    } else {
      out.push(`- ${a[i] ?? ""}`);
      out.push(`+ ${b[j] ?? ""}`);
      i++;
      j++;
    }
  }
  return out.join("\n");
}

export function createEditTool(cwd: string): AgentTool {
  return {
    name: "edit",
    description:
      "Edit a file with one or more exact text replacements. Each " +
      "edits[].oldText must match a unique region of the file. Read " +
      "the file first if you are not certain of the exact bytes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    execute: async (args, signal): Promise<ToolResult> => {
      const { path, edits } = args as EditArgs;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error("edit: edits must be a non-empty array");
      }
      if (signal?.aborted) throw new Error("aborted");
      const absolute = resolveToCwd(path, cwd);
      const before = (await readFile(absolute)).toString("utf-8");
      let after = before;
      for (const edit of edits) {
        after = applyEdit(after, edit, path);
      }
      await writeFile(absolute, after, "utf-8");
      const details: EditDetails = { diff: makeDiff(before, after, path) };
      return {
        content: [
          {
            type: "text",
            text: `Replaced ${edits.length} block(s) in ${path}.`,
          },
        ],
        details,
      };
    },
  };
}
