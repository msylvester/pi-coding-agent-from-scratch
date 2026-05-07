# Tutorial: Build a pi-mono-style Coding Agent and TUI

A continuation of `build-pi-mono-agent-loop-tutorial.md`. The first
tutorial got you to a working `Agent` class with `subscribe`, `prompt`,
`steer`, `followUp`, `abort`, and a toy tool loop. This one layers on
the parts that turn that kernel into something you can use to actually
edit code:

- A **coding-agent system prompt** that shapes the model's behavior
- A set of **coding tools** (`read`, `write`, `edit`, `bash`, `grep`,
  `find`) modeled after `packages/coding-agent/src/core/tools/`
- Cross-cutting **path resolution** and **output truncation** helpers
- A minimal **TUI**: a `Terminal`, a `Component` interface, a `ChatLog`
  that re-renders on each agent event
- A **REPL** that wires user input to `agent.prompt()` and Ctrl-C to
  `agent.abort()`

Build it phase by phase. Every phase is runnable on its own. Each phase
ends with a `pi-mono anchor` — the path in the real package the reader
is invited to compare against.

> Targets the same single provider as tutorial 1 (Anthropic). Multi-
> provider remains the registry exercise mentioned at the end of the
> first tutorial.

---

## Phase 0 — Recap and setup

After tutorial 1 your `src/` looks like this:

```
src/
  types.ts        # message + content types, AssistantStreamEvent
  provider.ts     # streamAnthropic — raw provider stream
  agent-loop.ts   # runAgentLoop — orchestration generator
  agent.ts        # Agent class — stateful wrapper, subscribe/steer/abort
  tools.ts        # toy tools (add, get_time, notify_done)
  main.ts         # one-shot driver
```

By the end of this tutorial it will look like this:

```
src/
  types.ts
  provider.ts
  agent-loop.ts
  agent.ts
  tools.ts                       # untouched (kept for tests)
  system-prompt.ts               # Phase 1
  coding-tools/
    path-utils.ts                # Phase 2
    truncate.ts                  # Phase 2
    read.ts                      # Phase 3
    write.ts                     # Phase 4
    edit.ts                      # Phase 4
    bash.ts                      # Phase 5
    grep.ts                      # Phase 6
    find.ts                      # Phase 6
    index.ts                     # re-exports + factory
  terminal.ts                    # Phase 8
  tui.ts                         # Phase 8
  chat-log.ts                    # Phase 9
  input.ts                       # Phase 10 (Component-style sketch)
  main.ts                        # rewritten in Phase 7 and Phase 10
```

Install the new dependencies up-front so each phase stays focused:

```bash
npm install glob
npm install -D @types/node
```

You will also need `ripgrep` on your `PATH` for Phase 6:

```bash
# macOS
brew install ripgrep
# Linux (Debian/Ubuntu)
sudo apt install ripgrep
```

One small tweak to `provider.ts` before we start: bump `max_tokens` so
the model can write longer files and longer reasoning chains:

```ts
// src/provider.ts — inside streamAnthropic()
const response = await client.messages.stream(
  {
    model: "claude-haiku-4-5",
    max_tokens: 8192,           // was 1024
    system: systemPrompt,
    messages: apiMessages,
    tools: tools.length ? tools : undefined,
  },
  { signal },
);
```

That's it for setup. Each subsequent phase adds files; nothing in
`agent.ts`, `agent-loop.ts`, or `types.ts` needs to change.

---

## Phase 1 — A coding-agent system prompt

Goal: replace the throwaway `"Be concise. Use tools when useful."`
prompt with one that explains the tools, the working directory, and a
few non-negotiable rules. The shape mirrors pi-mono's:

- A header sentence describing the agent's role
- An `Available tools` section, one line per tool
- A `Guidelines` section with conditional rules (e.g. "prefer grep
  over bash for search if you have grep")
- A trailing `Current date` and `Current working directory` line

`src/system-prompt.ts`:

```ts
export interface BuildSystemPromptOptions {
  cwd: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  appendSystemPrompt?: string;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const { cwd, selectedTools, toolSnippets, appendSystemPrompt } = options;

  const tools = selectedTools ?? ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList = visibleTools.length
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
    : "(none)";

  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");

  const guidelines: string[] = [];
  if (hasBash && !hasGrep && !hasFind) {
    guidelines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind)) {
    guidelines.push(
      "Prefer grep/find over bash for file exploration (faster, respects .gitignore)",
    );
  }
  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  let prompt = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

Guidelines:
${guidelines.map((g) => `- ${g}`).join("\n")}`;

  if (appendSystemPrompt) {
    prompt += `\n\n${appendSystemPrompt}`;
  }
  prompt += `\n\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${cwd}`;
  return prompt;
}
```

Wire it into `Agent` construction. Update `src/main.ts` to print the
prompt at startup so you can see the wiring:

```ts
import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./system-prompt.js";

const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  selectedTools: ["read", "bash", "edit", "write"],
  toolSnippets: {
    read: "Read file contents",
    bash: "Execute bash commands",
    edit: "Make precise file edits with exact text replacement",
    write: "Create or overwrite files",
  },
});
console.log("---- system prompt ----");
console.log(systemPrompt);
console.log("---- end ----");

const agent = new Agent({ systemPrompt, tools: [] });
```

Run `npm run dev --prompt "ping"` and inspect the printed prompt. The
key thing is that the `Available tools` list reflects exactly the
`toolSnippets` you provided — a tool only shows up if you give the model
a one-line snippet for it. That's how pi-mono lets a single
`buildSystemPrompt` serve every tool combination.

> **pi-mono anchor**:
> `packages/coding-agent/src/core/system-prompt.ts:28-147`. The real
> version also injects a `# Project Context` section from `AGENTS.md` /
> `CLAUDE.md` files and a skills section. Both are extensions of the
> same shape we just built.

---

## Phase 2 — Cross-cutting helpers: paths and truncation

Every file tool needs to (a) resolve a user-supplied path against the
agent's `cwd`, and (b) cap its output so a runaway file doesn't fill
the model's context. Pull both out before writing tools.

`src/coding-tools/path-utils.ts`:

```ts
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function expandPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return homedir() + filePath.slice(1);
  return filePath;
}

/** Resolve a path relative to cwd. Handles ~ expansion and absolute paths. */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd, expanded);
}
```

`src/coding-tools/truncate.ts`:

```ts
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate content to the first N lines / first N bytes, whichever
 * limit is hit first. Never returns a partial line.
 */
export function truncateHead(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";

  return {
    content: out.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: bytes,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}
```

Two limits, whichever fires first. Lines are never split mid-content,
so the model always gets a clean prefix it can reason about. The
`TruncationResult` is what every tool puts in its `details` field so
the UI can render a `[Truncated: N of M lines]` warning later.

A quick smoke test:

```ts
import { resolveToCwd } from "./coding-tools/path-utils.js";
import { truncateHead } from "./coding-tools/truncate.js";

console.log(resolveToCwd("~/foo", "/bar"));        // -> /Users/.../foo
console.log(resolveToCwd("./baz", "/bar"));        // -> /bar/baz
const r = truncateHead("a\nb\nc\nd\n", { maxLines: 2 });
console.log(r);                                    // outputLines=2, totalLines=5
```

> **pi-mono anchors**:
> `packages/coding-agent/src/core/tools/path-utils.ts:54-94` (the real
> `resolveReadPath` adds three macOS quirks — NFD normalization, narrow
> no-break space before AM/PM in screenshot names, and curly-quote
> apostrophes), and
> `packages/coding-agent/src/core/tools/truncate.ts:11-127`.

---

## Phase 3 — `read`

Goal: a tool that reads a text file, supports `offset` and `limit`,
truncates oversize files, and produces a result the agent loop can
hand to the model.

The pi-mono `read` also handles images (resizes to 2000×2000, returns
`ImageContent`). For the tutorial we keep the model's input text-only —
images get a `[image omitted]` note. That keeps the result type
compatible with the `ToolResult = { content: TextContent[]; details?;
terminate? }` you defined in tutorial 1.

`src/coding-tools/read.ts`:

```ts
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
```

Quick smoke test in `main.ts`:

```ts
import { createReadTool } from "./coding-tools/read.js";

const read = createReadTool(process.cwd());
const result = await read.execute({ path: "package.json" });
console.log(result.content[0].text);
console.log("---");
const sliced = await read.execute({ path: "package.json", offset: 1, limit: 3 });
console.log(sliced.content[0].text);
```

Notice the *continuation* hint at the end of a truncated read. That
text is what nudges the model to call `read` again with `offset=N+1`
instead of giving up. Tools that fail silently produce models that
fail silently.

> **pi-mono anchor**:
> `packages/coding-agent/src/core/tools/read.ts:19-340`. Differences:
> the real version returns `(TextContent | ImageContent)[]`, resizes
> images via `@silvia-odwyer/photon-node`, swaps the truncation note
> wording when bytes vs lines hit first, and exposes a pluggable
> `ReadOperations` interface so an extension can swap the local
> filesystem for SSH or a remote FS.

---

## Phase 4 — `write` and `edit`

Two file mutation tools. `write` is the simple case — overwrite the
file. `edit` is the precise case — find an exact substring and replace
it, refusing the operation if the substring isn't unique.

### write

`src/coding-tools/write.ts`:

```ts
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
```

### edit

The interesting bit is the uniqueness check. If `oldText` matches more
than once, you cannot know which one the model meant — so refuse and
ask for a longer surrounding context. Same if it doesn't match at all.

`src/coding-tools/edit.ts`:

```ts
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
```

Two things to notice:

1. **Each `oldText` is matched against the original file**, not against
   the result of previous edits. That means edits can be re-ordered
   safely — but it also means overlapping edits are an error you must
   surface. The error message tells the model exactly how to recover.
2. **The diff goes in `details`, not in `content`.** The model sees
   `Replaced 2 block(s) in foo.ts.` — short. The TUI in Phase 9 reads
   `details.diff` and renders it in the chat log. This is the same
   split pi-mono uses.

> **pi-mono anchors**:
> `packages/coding-agent/src/core/tools/write.ts:14-282` (write also
> serializes via a `withFileMutationQueue` so two concurrent edits on
> the same file are sequenced),
> `packages/coding-agent/src/core/tools/edit.ts:42-490` (edit also
> normalizes BOM, preserves CRLF/LF line endings, and produces a
> proper unified diff via `edit-diff.ts`).

---

## Phase 5 — `bash`

Goal: spawn a child process, stream stdout+stderr, kill the process
tree on `AbortSignal` or timeout, truncate the captured output, and
write the full output to a temp file so the model can re-read it
later.

`src/coding-tools/bash.ts`:

```ts
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
```

Three details that matter:

- `detached: true` lets us kill the whole process group with
  `process.kill(-pid)`. Without it, killing `bash` leaves its child
  processes running.
- The abort handler is `{ once: true }` and removed in both success
  and error paths — leak prevention.
- `fullOutputPath` is what saves you when `npm install` produces 80KB
  of output. The model gets a 50KB head, sees the path, and can
  `read` the rest with `offset` if it needs to.

A smoke test:

```ts
import { createBashTool } from "./coding-tools/bash.js";

const bash = createBashTool(process.cwd());
const r1 = await bash.execute({ command: "echo hello && echo world" });
console.log(r1);

// timeout test
try {
  await bash.execute({ command: "sleep 5", timeout: 1 });
} catch (e) {
  console.log("expected:", (e as Error).message);
}
```

> **pi-mono anchor**:
> `packages/coding-agent/src/core/tools/bash.ts:23-260`. The real
> version uses a shared `killProcessTree` helper that handles Windows
> via `taskkill /T /F`, an `OutputAccumulator` that throttles update
> events at 100 ms, a configurable `commandPrefix` (e.g. for `nvm`
> setup), and pluggable `BashOperations` so an extension can route
> commands to a remote shell.

---

## Phase 6 — `grep` and `find`

Two short search tools. They shell out to `ripgrep` and use the `glob`
package, matching pi-mono's choices. If you would rather build them
from `fs.readdir` + `RegExp`, you can — but `rg` and `glob` already
respect `.gitignore`, handle Unicode, and are an order of magnitude
faster.

### grep

`src/coding-tools/grep.ts`:

```ts
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
```

### find

`src/coding-tools/find.ts`:

```ts
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
```

Two smoke tests:

```ts
import { createGrepTool } from "./coding-tools/grep.js";
import { createFindTool } from "./coding-tools/find.js";

const grep = createGrepTool(process.cwd());
const find = createFindTool(process.cwd());
console.log((await grep.execute({ pattern: "TODO", path: "src" })).content[0].text);
console.log((await find.execute({ pattern: "**/*.ts" })).content[0].text);
```

> **pi-mono anchors**:
> `packages/coding-agent/src/core/tools/grep.ts:23-44` (uses `rg
> --json` and parses match objects rather than newline output, so it
> can pull out byte offsets and column positions),
> `packages/coding-agent/src/core/tools/find.ts:20-35`.

---

## Phase 7 — Drive a real coding task

Now wire the tools into `Agent` and run a real task. Replace the body
of `src/main.ts`:

```ts
import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createBashTool } from "./coding-tools/bash.js";
import { createEditTool } from "./coding-tools/edit.js";
import { createFindTool } from "./coding-tools/find.js";
import { createGrepTool } from "./coding-tools/grep.js";
import { createReadTool } from "./coding-tools/read.js";
import { createWriteTool } from "./coding-tools/write.js";

const cwd = process.cwd();
const tools = [
  createReadTool(cwd),
  createWriteTool(cwd),
  createEditTool(cwd),
  createBashTool(cwd),
  createGrepTool(cwd),
  createFindTool(cwd),
];

const systemPrompt = buildSystemPrompt({
  cwd,
  selectedTools: tools.map((t) => t.name),
  toolSnippets: {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise file edits with exact text replacement",
    bash: "Execute bash commands",
    grep: "Search file contents (ripgrep)",
    find: "Find files by glob",
  },
});

const agent = new Agent({ systemPrompt, tools });

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
    process.stdout.write(event.assistantEvent.delta);
  }
  if (event.type === "tool_execution_start") {
    process.stdout.write(`\n\n[tool] ${event.toolName} ${JSON.stringify(event.args)}\n`);
  }
  if (event.type === "tool_execution_end") {
    const text = event.result.content.map((c) => c.text).join("");
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    process.stdout.write(`[result] ${preview}\n\n`);
  }
});

const prompt =
  process.argv.slice(2).join(" ") ||
  "Find every TODO comment in src/, and write a TODOS.md at the repo root summarizing each one with its file path and line number.";

await agent.prompt(prompt);
console.log("\n[done]");
```

Run it:

```bash
npm run dev -- "$(echo your prompt here)"
```

You should see the model issue a `find` (or `grep`) call, get the
results, possibly chain a `read` for context, and finally `write` the
summary file. The whole chain runs through the same agent loop you
built in tutorial 1 — the only thing that changed is the tool set and
the system prompt.

If it goes off the rails (writes the wrong file, opens too much
context), `Ctrl-C` to abort. Tutorial 1 wired the abort signal all
the way through to the SDK call, and the bash tool in Phase 5 wired
it through to `killTree` — abort is end-to-end.

> **No new pi-mono anchor for this phase.** Compare your
> `main.ts` to `packages/coding-agent/src/cli.ts` for the entry-point
> shape, and `packages/coding-agent/src/modes/print/print-mode.ts` for
> the equivalent of "subscribe and dump events to stdout".

---

## Phase 8 — A minimal `Terminal` and `Component`

We have an agent that does real work. Now build the UI layer that lets
a user *talk* to it interactively instead of one prompt at a time.

The TUI in pi-mono is built on three core abstractions:

- `Terminal` — wraps stdin/stdout, raw mode, dimensions, cursor.
- `Component` — anything that can be rendered as `string[]` for a
  given width. Has optional `handleInput(data)` for keystrokes.
- `TUI` — owns a tree of components and a render loop.

For the tutorial we collapse `TUI` into a tiny render loop in
`chat-log.ts` and keep `Terminal` and `Component` as the primitives.

`src/terminal.ts`:

```ts
export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  hideCursor(): void;
  showCursor(): void;
  clearScreen(): void;
}

export class ProcessTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", onResize);
  }

  stop(): void {
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.resizeHandler!);
    process.stdin.setRawMode?.(this.wasRaw);
    process.stdin.pause();
    this.showCursor();
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns ?? 80;
  }
  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  hideCursor(): void {
    process.stdout.write("\x1b[?25l");
  }
  showCursor(): void {
    process.stdout.write("\x1b[?25h");
  }
  clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  private onData = (data: string) => {
    this.inputHandler?.(data);
  };
}
```

`src/tui.ts`:

```ts
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

That's it. Two files. The full pi-tui has hundreds of lines of
synchronized output, kitty-protocol negotiation, hardware-cursor
positioning, and a three-strategy diff renderer — none of which we
need to demonstrate the pattern.

A smoke test, just to confirm raw mode works:

```ts
import { ProcessTerminal } from "./terminal.js";

const term = new ProcessTerminal();
term.start(
  (data) => {
    if (data === "\x03") {
      // Ctrl-C
      term.stop();
      process.exit(0);
    }
    term.write(`got: ${JSON.stringify(data)}\n`);
  },
  () => term.write(`resize: ${term.columns}x${term.rows}\n`),
);
term.write("Type anything. Ctrl-C to quit.\n");
```

> **pi-mono anchors**:
> `packages/tui/src/terminal.ts:16-58` (the interface; the
> `ProcessTerminal` implementation is another ~600 lines that handle
> Kitty keyboard protocol, OSC progress sequences, modify-other-keys
> mode, Windows VT input, paste mode, and a dedicated stdin buffer
> that drains pending events on shutdown), and
> `packages/tui/src/tui.ts:17-41` (the `Component` interface — same
> three methods plus a `wantsKeyRelease` opt-in for Kitty).

---

## Phase 9 — Streaming the agent into a chat log

Goal: a `ChatLog` component that subscribes to `agent` events and
re-renders whenever something changes. We deliberately use a *naive*
render strategy: clear the screen, print the chat lines, print a
prompt area at the bottom. No diff rendering, no flicker reduction.
The point is to see the structure.

`src/chat-log.ts`:

```ts
import type { Agent } from "./agent.js";
import type { Terminal } from "./terminal.js";
import type { Component } from "./tui.js";

type Row =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool-call"; name: string; args: unknown }
  | { kind: "tool-result"; name: string; text: string; isError: boolean };

export class ChatLog implements Component {
  private rows: Row[] = [];
  private streamingAssistant?: { kind: "assistant"; text: string };

  constructor(
    private term: Terminal,
    agent: Agent,
  ) {
    agent.subscribe((event) => this.onEvent(event));
  }

  private onEvent(event: Parameters<Parameters<Agent["subscribe"]>[0]>[0]): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "user") {
          this.rows.push({
            kind: "user",
            text: event.message.content.map((c) => c.text).join(""),
          });
          this.streamingAssistant = undefined;
        } else if (event.message.role === "assistant") {
          this.streamingAssistant = { kind: "assistant", text: "" };
          this.rows.push(this.streamingAssistant);
        }
        break;

      case "message_update":
        if (
          this.streamingAssistant &&
          event.assistantEvent.type === "text_delta"
        ) {
          this.streamingAssistant.text += event.assistantEvent.delta;
        }
        break;

      case "tool_execution_start":
        this.rows.push({
          kind: "tool-call",
          name: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_end":
        this.rows.push({
          kind: "tool-result",
          name: event.toolName,
          text: event.result.content.map((c) => c.text).join(""),
          isError: event.result.isError,
        });
        break;

      case "message_end":
      case "agent_end":
        this.streamingAssistant = undefined;
        break;
    }
    this.draw();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const row of this.rows) {
      switch (row.kind) {
        case "user":
          lines.push(`${dim("›")} ${row.text}`);
          break;
        case "assistant":
          for (const line of row.text.split("\n")) lines.push(`  ${line}`);
          break;
        case "tool-call":
          lines.push(
            `${dim("·")} ${row.name}(${truncate(JSON.stringify(row.args), width - 6)})`,
          );
          break;
        case "tool-result": {
          const prefix = row.isError ? red("✗") : dim("←");
          const first = row.text.split("\n").slice(0, 5).join("\n");
          const remaining = row.text.split("\n").length - 5;
          lines.push(`${prefix} ${truncate(first, width - 2)}`);
          if (remaining > 0) lines.push(dim(`  (+${remaining} more lines)`));
          break;
        }
      }
      lines.push("");
    }
    return lines;
  }

  private draw(): void {
    this.term.clearScreen();
    const width = this.term.columns;
    const lines = this.render(width);
    this.term.write(lines.join("\n") + "\n");
  }
}

function truncate(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[22m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[39m`;
}
```

Hook it into `main.ts` for a non-interactive run first:

```ts
// src/main.ts (additions)
import { ProcessTerminal } from "./terminal.js";
import { ChatLog } from "./chat-log.js";

const term = new ProcessTerminal();
term.hideCursor();
new ChatLog(term, agent);
process.on("exit", () => {
  term.showCursor();
  term.write("\n");
});

await agent.prompt(prompt);
```

Run a coding prompt and watch the screen rebuild on each event.
Streaming text appears character-by-character; tool calls and results
appear as their own rows. There is visible flicker on every redraw —
that's why pi-tui exists — but the structure is correct.

The `streamingAssistant` reference trick is what lets `message_update`
mutate the *last* assistant row in place instead of pushing a new row
on every delta. Same trick pi-mono's interactive mode uses.

> **pi-mono anchors**:
> `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
> around lines 2620–2730 — that's the real `handleEvent` dispatch.
> Each event type maps to a richer Component subclass (`UserMessage`,
> `AssistantMessage`, `ToolExecution`, with theme-aware colors,
> markdown-rendered text, syntax highlighting, and per-tool custom
> renderers). The differential rendering happens up in
> `packages/tui/src/tui.ts`.

---

## Phase 10 — Input and the REPL

Two steps. First a `readline`-based REPL so you have something working
in 10 lines. Then a Component-style `Input` so you have seen the shape
pi-tui uses.

### 10a — readline (the pragmatic version)

`readline` does the cursor / backspace / arrow keys / paste handling
for you. The catch is that it *also* draws to the same stdout that
your `ChatLog` is rebuilding on every event — so you have to choose:
either read-loop *or* live chat-log render, not both at once.

The simplest workable pattern: pause `ChatLog` redraws while waiting
for input, draw a prompt, read a line, fire `agent.prompt(...)`, let
`ChatLog` redraw freely until the agent goes idle, then loop.

`src/main.ts` (REPL version):

```ts
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.js";
import { ChatLog } from "./chat-log.js";
import { ProcessTerminal } from "./terminal.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createBashTool } from "./coding-tools/bash.js";
import { createEditTool } from "./coding-tools/edit.js";
import { createFindTool } from "./coding-tools/find.js";
import { createGrepTool } from "./coding-tools/grep.js";
import { createReadTool } from "./coding-tools/read.js";
import { createWriteTool } from "./coding-tools/write.js";

const cwd = process.cwd();
const tools = [
  createReadTool(cwd),
  createWriteTool(cwd),
  createEditTool(cwd),
  createBashTool(cwd),
  createGrepTool(cwd),
  createFindTool(cwd),
];
const agent = new Agent({
  systemPrompt: buildSystemPrompt({
    cwd,
    selectedTools: tools.map((t) => t.name),
    toolSnippets: {
      read: "Read file contents",
      write: "Create or overwrite files",
      edit: "Make precise file edits with exact text replacement",
      bash: "Execute bash commands",
      grep: "Search file contents (ripgrep)",
      find: "Find files by glob",
    },
  }),
  tools,
});

const term = new ProcessTerminal();
const chat = new ChatLog(term, agent);

process.on("SIGINT", () => {
  if (agent.isStreaming) agent.abort();
  else process.exit(0);
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
while (true) {
  const text = await rl.question("\n› ");
  if (!text.trim()) continue;
  if (text === "/quit") break;
  await agent.prompt(text);
  await agent.waitForIdle();
}
rl.close();
```

Three notes:

- We do not call `term.start()` here because `readline` is in charge
  of stdin while `rl.question` is awaiting. `ChatLog` only writes to
  stdout (via `term.write` / `term.clearScreen`).
- `SIGINT` does double duty: abort the agent if it's streaming,
  exit the program otherwise. That matches pi-mono's
  "first Ctrl-C interrupts, second Ctrl-C quits" pattern in spirit
  if not in detail.
- `await agent.waitForIdle()` is the API your tutorial-1 `Agent`
  exposed via the private `activeRun` promise. Without it the next
  `rl.question` call races against the agent stream.

You now have a usable coding REPL. Try:

```
› refactor src/agent.ts to extract the prompt + continue logic into a private run() method
```

…and watch the agent read, think, edit, then summarize.

### 10b — A Component-style `Input` (the fidelity version)

The readline version works but it leaks abstraction: `readline` owns
stdin, your `Component` tree does not. pi-tui's `Input` is a
`Component` like any other — it implements `render(width)` and
`handleInput(data)`. Let's sketch it.

`src/input.ts`:

```ts
import type { Component } from "./tui.js";

export class Input implements Component {
  private value = "";
  private cursor = 0;
  focused = true;
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  onChange?: () => void;

  getValue(): string {
    return this.value;
  }
  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  render(width: number): string[] {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const cursorChar = this.focused ? "\x1b[7m \x1b[27m" : " ";
    let line = `› ${before}${cursorChar}${after}`;
    if (line.length > width) line = line.slice(line.length - width);
    return [line];
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
      this.value = "";
      this.cursor = 0;
    } else if (data === "\x1b") {
      this.onEscape?.();
    } else if (data === "\x7f") {
      // backspace
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor--;
      }
    } else if (data === "\x1b[D") {
      if (this.cursor > 0) this.cursor--;
    } else if (data === "\x1b[C") {
      if (this.cursor < this.value.length) this.cursor++;
    } else if (data >= " " && !data.startsWith("\x1b")) {
      this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
      this.cursor += data.length;
    }
    this.onChange?.();
  }

  invalidate(): void {}
}
```

In a real TUI you would add an `Input` instance below the `ChatLog`,
let `Terminal.start()` route every keystroke through
`input.handleInput`, and have the parent `redraw` after each call.
The wiring (skeleton, not running code):

```ts
const input = new Input();
input.onSubmit = (text) => {
  if (text.trim()) void agent.prompt(text);
};
term.start(
  (data) => {
    if (data === "\x03") {
      if (agent.isStreaming) agent.abort();
      else { term.stop(); process.exit(0); }
      return;
    }
    input.handleInput(data);
    redraw();
  },
  () => redraw(),
);
function redraw() {
  term.clearScreen();
  const w = term.columns;
  const chatLines = chat.render(w);
  const inputLines = input.render(w);
  term.write(chatLines.join("\n") + "\n" + inputLines.join("\n"));
}
agent.subscribe(() => redraw());
```

That is roughly what pi-tui does — minus the differential renderer
that avoids re-writing the whole screen on every keystroke. If you
want to ship this you will hit the flicker problem fast, which is
exactly the problem `packages/tui/src/tui.ts` solves.

> **pi-mono anchors**: the real `Input` lives at
> `packages/tui/src/components/input.ts:18-140` and handles paste
> markers, focus state, submit-on-newline rules, and a `Focusable`
> contract that lets `TUI` put the hardware cursor at the right
> column. The interactive mode wires user input to the agent in
> `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
> around lines 2440–2603, with the abort wiring at line 1617 and the
> Ctrl-C double-tap handler at line 3200.

---

## Phase 11 — What you have now

You added roughly 1000–1500 lines on top of tutorial 1, in two layers:

**Coding-agent layer**
- `system-prompt.ts` — tool-aware prompt builder
- `coding-tools/path-utils.ts`, `truncate.ts` — cross-cutting helpers
- `coding-tools/{read,write,edit,bash,grep,find}.ts` — six real tools
  with schemas, abort handling, output truncation, and structured
  `details` slots

**TUI layer**
- `terminal.ts` — `Terminal` interface + `ProcessTerminal`
- `tui.ts` — `Component` interface
- `chat-log.ts` — full-screen redraw chat log subscribed to agent
  events
- `input.ts` — single-line `Input` component
- `main.ts` — REPL wiring `ChatLog`, `Input`, and `Agent` together

What pi-mono does on top:

| Feature | Where in pi-mono | What you'd add |
| --- | --- | --- |
| Differential rendering / synchronized output | `packages/tui/src/tui.ts` | Three-strategy diff render, CSI 2026 atomic frames |
| Markdown component with ANSI styling | `packages/tui/src/components/markdown.ts` | Replace plain text in `ChatLog` with parsed Markdown |
| Editor component (multi-line, paste markers, autocomplete, undo) | `packages/tui/src/components/editor.ts` | Replace single-line `Input` |
| Inline images (Kitty / iTerm2 protocols) | `packages/tui/src/terminal-image.ts` | Display tool results that include images |
| Loader / spinner integration | `packages/tui/src/components/loader.ts` | Show during model thinking, stop when streaming begins |
| Pluggable tool operations (SSH, remote FS) | `*Operations` interfaces in each `core/tools/*.ts` | Inject custom impls into the tool factories |
| Permissions / approval | `packages/coding-agent/src/core/permissions/` | Wrap `execute` with allow/deny prompts |
| Session persistence | `packages/coding-agent/src/core/session-manager.ts` | Append each `message_end` to a JSONL log; replay on startup |
| Slash commands, extensions, skills, themes | `packages/coding-agent/src/extensions/`, `slash-commands.ts` | Pre-process input before `agent.prompt()` |
| Multi-provider routing | `packages/ai/src/api-registry.ts` | Same registry exercise from tutorial 1 |
| Auto-compaction | `packages/coding-agent/src/compaction/` | A `transformContext` that summarizes old turns |

Extracting your `coding-tools/` directory into its own package, gating
each `execute` behind a permissions layer, swapping the readline REPL
for an `Editor` component on top of a real differential renderer, and
keeping a JSONL session log on the side — that's roughly the boundary
between this tutorial and the `pi-coding-agent` package.

## Suggested verification along the way

| Phase | Test |
| --- | --- |
| 1 | Print the system prompt at startup; confirm the `Available tools` list reflects exactly the snippets you provided |
| 2 | `resolveToCwd("~/foo", "/bar")` returns `<HOME>/foo`; `truncateHead("a\nb\nc\nd", { maxLines: 2 })` reports `truncated: true, totalLines: 4` |
| 3 | `read({ path: "package.json" })` returns the file; `read({ path: "package.json", offset: 1, limit: 2 })` returns the first two lines with a continuation note |
| 4 | `write` followed by `read` round-trips; `edit` with a non-unique `oldText` errors with the "matches multiple locations" message |
| 5 | `bash({ command: "sleep 5", timeout: 1 })` rejects with `timeout: 1s`; the truncated case writes a temp file and the path appears in the result text |
| 6 | `grep("TODO", { path: "src" })` returns matches with `file:line:text`; `find({ pattern: "**/*.ts" })` returns a list capped at the limit |
| 7 | A "summarize TODOs" prompt produces a real `TODOS.md` via `find` → `grep` → `write` in one agent run |
| 8 | `ProcessTerminal.write("hello\n")` appears immediately; raw stdin echoes keystrokes to the input handler |
| 9 | Streaming model output appears character-by-character in the chat log; tool calls and tool results appear as their own rows |
| 10 | Type a prompt → see streaming response → type next prompt → previous turn is still visible; first Ctrl-C aborts the in-flight stream, second exits |

If a phase misbehaves, log the agent event stream and the tool's raw
result. Every interesting state transition has a named event, just
like pi-mono.
