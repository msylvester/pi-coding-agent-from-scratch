# Tutorial: Build a pi-mono-style Agent Harness

A continuation of `build-pi-mono-coding-agent-tutorial.md`. By the end
of that tutorial you had a stateful `Agent` driving a set of real
coding tools through a streaming Anthropic call, plus a minimal TUI.
The kernel works — but every "real" pi-mono agent (the CLI, the
coding-agent package, downstream apps) goes through one more layer:
the **harness**.

The harness is what turns the raw `Agent` into something an
application can build on. It owns:

- A **persistent session tree** — every user message, assistant
  message, tool result, model change, and compaction is appended as a
  tree entry. Context for the next turn is rebuilt from the tree
  rather than from the agent's in-memory `messages` array.
- An **`ExecutionEnv`** — a portable filesystem + shell interface that
  tools call into. The same tool code runs against a local Node
  filesystem, a remote SSH host, a Docker sandbox, or an in-memory
  fake.
- **Skills and prompt templates** — markdown files on disk loaded into
  a `resources` bag and surfaced to the model (skills) or to the user
  as slash-style commands (prompt templates).
- **Lifecycle hooks** — typed handlers (`on("tool_result", …)`,
  `on("context", …)`, `on("before_provider_request", …)`) that can
  modify a tool's output, edit the context window, patch outgoing
  request headers, or block a tool call entirely.
- **Compaction** — when the conversation outgrows the context window
  the harness summarizes the older turns into a single
  `compactionSummary` message and rebuilds context from there.

This tutorial layers the harness on top of the coding agent. As
before, every phase is runnable and ends with a `pi-mono anchor` —
the path in the real package the reader is invited to compare
against.

> Targets the same single Anthropic provider as tutorials 1 and 2.
> Multi-provider routing remains the registry exercise mentioned at
> the end of tutorial 1.

---

## Phase 0 — Recap and the shape of the harness

At the end of tutorial 2 your `src/` looked like this:

```
src/
  types.ts
  provider.ts
  agent-loop.ts
  agent.ts
  tools.ts
  system-prompt.ts
  coding-tools/
    path-utils.ts
    truncate.ts
    read.ts
    write.ts
    edit.ts
    bash.ts
    grep.ts
    find.ts
    index.ts
  terminal.ts
  tui.ts
  chat-log.ts
  input.ts
  main.ts
```

By the end of this tutorial it will look like this:

```
src/
  types.ts
  provider.ts
  agent-loop.ts
  agent.ts                       # untouched
  tools.ts
  system-prompt.ts
  coding-tools/
    …
  terminal.ts
  tui.ts
  chat-log.ts
  input.ts
  harness/
    env.ts                       # Phase 1 — ExecutionEnv interface + NodeExecutionEnv
    messages.ts                  # Phase 2 — branch/compaction summary message types
    session-storage.ts           # Phase 2 — SessionStorage interface + InMemorySessionStorage
    session.ts                   # Phase 2 — Session (typed entry append helpers)
    types.ts                     # Phase 3 — harness types (Skill, PromptTemplate, hooks, events)
    agent-harness.ts             # Phase 3 — AgentHarness class
    skills.ts                    # Phase 5 — loadSkills, formatSkillInvocation
    prompt-templates.ts          # Phase 6 — loadPromptTemplates, substituteArgs
    compaction.ts                # Phase 7 — prepareCompaction, compact, generateSummary
    jsonl-storage.ts             # Phase 9 — append-only JSONL persistence (sketch)
  main.ts                        # rewritten in Phase 3 and Phase 10
```

Nothing in `agent.ts`, `agent-loop.ts`, `provider.ts`, or `types.ts`
needs to change. The harness wraps `Agent` from the outside.

Two mental models worth keeping straight before you start:

- **The `Agent` owns the in-flight turn.** It holds the
  `state.messages` array that the provider sees, runs tools, and
  emits events. It is short-lived in the sense that it forgets
  nothing — but it also does not persist anything.
- **The harness owns everything around the turn.** Before each turn
  it rebuilds the agent's context from the session tree. After each
  message it appends a new entry. When the session gets too big it
  rewrites part of the tree into a summary. The `Agent` does not know
  the session exists.

The hook into `Agent` that makes this possible is `prepareNextTurn`,
combined with `transformContext`, `beforeToolCall`, and
`afterToolCall`. Tutorial 1 introduced the latter three; the harness
sits on the same edges.

> **pi-mono anchor**: the real harness lives at
> `packages/agent/src/harness/`. The class itself is
> `agent-harness.ts:119-816`. Skim it once and notice how short the
> class is — most of the surface area is just routing between the
> session, the hooks, and `Agent`.

---

## Phase 1 — `ExecutionEnv`: filesystem and shell as an interface

Goal: extract the `fs/promises` and `child_process` calls scattered
through the Phase 3–6 coding tools into a single interface. Same code,
new seam. The payoff is that you can later swap in a remote SSH env,
a Docker sandbox, or a fake env for tests — without touching a single
tool.

The interface is mostly what you'd write by hand: read text, read
bytes, write, stat, list, exec a command, plus a few escape hatches
(`createTempDir`, `createTempFile`, `remove`, `realPath`).

`src/harness/env.ts`:

```ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access, lstat, mkdir, mkdtemp, readdir, readFile,
  realpath, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type FileKind = "file" | "directory" | "symlink";

export type FileErrorCode =
  | "not_found" | "permission_denied" | "not_directory"
  | "is_directory" | "invalid" | "not_supported" | "unknown";

export class FileError extends Error {
  constructor(
    public code: FileErrorCode,
    message: string,
    public path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileError";
  }
}

export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;          // seconds
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecutionEnv {
  cwd: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readTextFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  fileInfo(path: string): Promise<FileInfo>;
  listDir(path: string): Promise<FileInfo[]>;
  realPath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  createDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  createTempDir(prefix?: string): Promise<string>;
  createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string>;
  cleanup(): Promise<void>;
}
```

The `NodeExecutionEnv` is mechanical. The only subtle bit is mapping
`NodeJS.ErrnoException.code` to a stable `FileErrorCode` — tools
should not have to switch on `"ENOENT"` vs `"EACCES"` vs `"ENOTDIR"`
once they cross this boundary.

```ts
function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "ENOENT":            return new FileError("not_found",          error.message, path);
      case "EACCES": case "EPERM": return new FileError("permission_denied", error.message, path);
      case "ENOTDIR":           return new FileError("not_directory",      error.message, path);
      case "EISDIR":            return new FileError("is_directory",       error.message, path);
      case "EINVAL":            return new FileError("invalid",            error.message, path);
    }
  }
  return new FileError("unknown", String(error), path);
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export class NodeExecutionEnv implements ExecutionEnv {
  cwd: string;
  constructor(options: { cwd: string }) { this.cwd = options.cwd; }

  async readTextFile(path: string): Promise<string> {
    const resolved = resolvePath(this.cwd, path);
    try { return await readFile(resolved, "utf8"); }
    catch (error) { throw toFileError(error, resolved); }
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const resolved = resolvePath(this.cwd, path);
    try { return await readFile(resolved); }
    catch (error) { throw toFileError(error, resolved); }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      await writeFile(resolved, content);
    } catch (error) { throw toFileError(error, resolved); }
  }

  async fileInfo(path: string): Promise<FileInfo> {
    const resolved = resolvePath(this.cwd, path);
    try {
      const stats = await lstat(resolved);
      const kind: FileKind =
        stats.isFile() ? "file" :
        stats.isDirectory() ? "directory" :
        stats.isSymbolicLink() ? "symlink" :
        (() => { throw new FileError("invalid", "Unsupported file type"); })();
      return {
        name: resolved.split("/").pop() ?? resolved,
        path: resolved,
        kind,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) { throw toFileError(error, resolved); }
  }

  async listDir(path: string): Promise<FileInfo[]> {
    const resolved = resolvePath(this.cwd, path);
    const entries = await readdir(resolved, { withFileTypes: true });
    const out: FileInfo[] = [];
    for (const entry of entries) {
      const p = resolve(resolved, entry.name);
      out.push(await this.fileInfo(p));
    }
    return out;
  }

  async realPath(path: string): Promise<string> {
    return await realpath(resolvePath(this.cwd, path));
  }

  async exists(path: string): Promise<boolean> {
    try { await this.fileInfo(path); return true; }
    catch (error) {
      if (error instanceof FileError && error.code === "not_found") return false;
      throw error;
    }
  }

  async createDir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(resolvePath(this.cwd, path), { recursive: options?.recursive });
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await rm(resolvePath(this.cwd, path), {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  async createTempDir(prefix: string = "tmp-"): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string> {
    const dir = await this.createTempDir();
    const filePath = join(dir, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
    await writeFile(filePath, "");
    return filePath;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
    return await new Promise((resolvePromise, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const timer =
        options.timeout != null
          ? setTimeout(() => child.pid && process.kill(-child.pid, "SIGKILL"),
                       options.timeout * 1000)
          : undefined;
      options.signal?.addEventListener("abort", () => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => { stdout += c; options.onStdout?.(c); });
      child.stderr?.on("data", (c: string) => { stderr += c; options.onStderr?.(c); });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
      });
      child.on("error", reject);
    });
  }

  async cleanup(): Promise<void> { /* nothing to do for local Node */ }
}
```

Now rewrite **one** tool to consume `ExecutionEnv` instead of importing
`fs/promises` directly. Pick `read` since it's simplest. The factory
shape becomes `createReadTool(env: ExecutionEnv)`:

```ts
// src/coding-tools/read.ts — relevant slice
import type { ExecutionEnv } from "../harness/env.js";
import type { AgentTool, ToolResult } from "../tools.js";
import { truncateHead } from "./truncate.js";

export function createReadTool(env: ExecutionEnv): AgentTool {
  return {
    name: "read",
    description: "Read a UTF-8 text file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
    async execute(args: { path: string; offset?: number; limit?: number }, signal): Promise<ToolResult> {
      try {
        const text = await env.readTextFile(args.path);
        const lines = text.split("\n");
        const start = args.offset ?? 0;
        const end = args.limit ? start + args.limit : lines.length;
        const slice = lines.slice(start, end).join("\n");
        const truncation = truncateHead(slice);
        return {
          content: [{ type: "text", text: truncation.content }],
          details: truncation,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  };
}
```

Repeat the pattern for `write`, `edit`, `bash` (calls `env.exec`),
`grep` (also `env.exec` with the `rg` binary), and `find` (either
`env.exec` with `fd`/`find`, or `env.listDir` recursively). Once
that's done, `main.ts` boots with `new NodeExecutionEnv({ cwd })` and
threads it through every tool factory:

```ts
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const tools = [
  createReadTool(env),
  createWriteTool(env),
  createEditTool(env),
  createBashTool(env),
  createGrepTool(env),
  createFindTool(env),
];
```

You haven't changed behavior. You've created a seam. Any future
"run on a remote machine" / "run inside a Docker container" /
"replay against a fake filesystem in tests" work hangs off this
interface and only this interface.

> **pi-mono anchor**:
> `packages/agent/src/harness/types.ts:139-174` (the `ExecutionEnv`
> interface), `packages/agent/src/harness/env/nodejs.ts:170-370` (the
> `NodeExecutionEnv` implementation). The real shell setup also
> searches for bash on Windows and uses `process.kill(-pid, …)` to
> kill the entire process group, both of which the snippet above only
> sketches.

---

## Phase 2 — Session tree

Goal: replace "messages are an array in `agent.state.messages`" with
"messages are nodes in a tree on disk." The harness will:

1. Append every user message, assistant message, and tool result as a
   tree entry (a node with a `parentId`).
2. Track a `leafId` — the current head of the active branch.
3. Rebuild the in-memory `messages` array on demand by walking from
   the leaf up to the root.

We will start with an in-memory implementation. JSONL persistence
comes in Phase 9.

### Entries

`src/harness/messages.ts`:

```ts
import type { TextContent, ToolCallContent, ToolResultContent } from "../types.js";

// Re-export the message types from tutorial 1 to keep the harness self-contained.
export type { AgentMessage, AssistantMessage, UserMessage, ToolResultMessage } from "../types.js";

/** Message produced by the compaction step (see Phase 7). */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/** Message produced by branch navigation (out of scope; placeholder). */
export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export const COMPACTION_PREFIX = "The conversation history before this point was compacted:\n\n<summary>\n";
export const COMPACTION_SUFFIX = "\n</summary>";

export function createCompactionSummaryMessage(summary: string, tokensBefore: number): CompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: Date.now() };
}
```

`src/harness/session-storage.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../types.js";

export interface SessionMetadata {
  id: string;
  createdAt: string;
}

interface BaseEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: AgentMessage;
}

export interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type SessionTreeEntry = MessageEntry | ModelChangeEntry | CompactionEntry;

export interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}

export class InMemorySessionStorage implements SessionStorage {
  private metadata: SessionMetadata;
  private entries: SessionTreeEntry[] = [];
  private byId = new Map<string, SessionTreeEntry>();
  private leafId: string | null = null;

  constructor() {
    this.metadata = { id: randomUUID(), createdAt: new Date().toISOString() };
  }

  async getMetadata() { return this.metadata; }
  async getLeafId() { return this.leafId; }
  async setLeafId(leafId: string | null) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error(`Entry ${leafId} not found`);
    this.leafId = leafId;
  }
  async createEntryId() {
    for (let i = 0; i < 100; i++) {
      const id = randomUUID().slice(0, 8);
      if (!this.byId.has(id)) return id;
    }
    return randomUUID();
  }
  async appendEntry(entry: SessionTreeEntry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }
  async getEntry(id: string) { return this.byId.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path;
  }
  async getEntries() { return [...this.entries]; }
}
```

### Session

`Session` is a thin layer on top of `SessionStorage` that exposes
typed append helpers and a `buildContext()` method. `buildContext` is
the bridge from "tree on disk" to "messages array the agent loop
expects."

`src/harness/session.ts`:

```ts
import type { AgentMessage } from "../types.js";
import type {
  CompactionEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionStorage,
  SessionTreeEntry,
} from "./session-storage.js";
import {
  COMPACTION_PREFIX,
  COMPACTION_SUFFIX,
  createCompactionSummaryMessage,
} from "./messages.js";

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
}

export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let model: { provider: string; modelId: string } | null = null;
  let compaction: CompactionEntry | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: AgentMessage[] = [];
  const appendIfMessage = (entry: SessionTreeEntry) => {
    if (entry.type === "message") messages.push(entry.message);
  };

  if (compaction) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: COMPACTION_PREFIX + compaction.summary + COMPACTION_SUFFIX }],
    });
    const compactionIdx = pathEntries.findIndex((e) => e === compaction);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      if (pathEntries[i].id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendIfMessage(pathEntries[i]);
    }
    for (let i = compactionIdx + 1; i < pathEntries.length; i++) appendIfMessage(pathEntries[i]);
  } else {
    for (const entry of pathEntries) appendIfMessage(entry);
  }

  return { messages, model };
}

export class Session {
  constructor(private storage: SessionStorage) {}

  getMetadata() { return this.storage.getMetadata(); }
  getLeafId() { return this.storage.getLeafId(); }
  getEntries() { return this.storage.getEntries(); }
  getEntry(id: string) { return this.storage.getEntry(id); }

  async getBranch(): Promise<SessionTreeEntry[]> {
    return this.storage.getPathToRoot(await this.storage.getLeafId());
  }

  async buildContext(): Promise<SessionContext> {
    return buildSessionContext(await this.getBranch());
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    const entry: MessageEntry = {
      type: "message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      message,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }

  async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<string> {
    const entry: CompactionEntry = {
      type: "compaction",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }
}
```

Two design notes worth pausing on:

1. **Why a tree, not a flat log?** Because Phase 7's compaction will
   want to "rewrite" the older half of the conversation without
   physically deleting it. A tree lets you set `leafId` to the new
   summary node while old branches remain reachable for inspection,
   forking, or "go back to where I was three turns ago."
2. **Why `buildContext` and not just append to `agent.state.messages`?**
   Because once compaction is in play, the context the model sees is
   no longer "everything that has happened" — it's "a summary plus
   everything since the last compaction." Reading it from the tree
   each turn keeps that logic in one place.

> **pi-mono anchors**:
> `packages/agent/src/harness/session/session.ts:77-251` (the real
> `Session`), `packages/agent/src/harness/session/storage/memory.ts`
> (in-memory storage), and the wider type set at
> `packages/agent/src/harness/types.ts:176-282`. The real entry union
> also covers `branch_summary`, `custom_message`, `label`,
> `session_info`, and `thinking_level_change`.

---

## Phase 3 — `AgentHarness`: the wrapping class

Now the centerpiece. `AgentHarness` owns an `Agent`, an
`ExecutionEnv`, and a `Session`. Its job is to glue them together by
overriding `prepareNextTurn`, listening to agent events, and exposing
a small public API (`prompt`, `subscribe`, `abort`, `setModel`).

`src/harness/types.ts`:

```ts
import type { Model } from "../provider.js";  // Phase 1 of tutorial 1
import type { AgentTool } from "../tools.js";
import type { AgentMessage } from "../types.js";
import type { ExecutionEnv } from "./env.js";
import type { Session } from "./session.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

export interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
}

export interface AgentHarnessResources {
  skills?: Skill[];
  promptTemplates?: PromptTemplate[];
}

export interface AgentHarnessOptions {
  env: ExecutionEnv;
  session: Session;
  tools?: AgentTool[];
  resources?: AgentHarnessResources;
  model: Model;
  systemPrompt?:
    | string
    | ((context: {
        env: ExecutionEnv;
        session: Session;
        model: Model;
        activeTools: AgentTool[];
        resources: AgentHarnessResources;
      }) => string | Promise<string>);
  apiKey: string;
}

// Hook event payloads — minimal slice of the real surface.
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}
export interface ContextResult { messages: AgentMessage[] }

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}
export interface ToolCallResult { block?: boolean; reason?: string }

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: { type: "text"; text: string }[];
  isError: boolean;
}
export interface ToolResultPatch {
  content?: { type: "text"; text: string }[];
  isError?: boolean;
  terminate?: boolean;
}

export interface SavePointEvent {
  type: "save_point";
  hadPendingMutations: boolean;
}

export interface SettledEvent { type: "settled" }

export type AgentHarnessOwnEvent =
  | ContextEvent | ToolCallEvent | ToolResultEvent | SavePointEvent | SettledEvent;

export type AgentHarnessEventResultMap = {
  context: ContextResult | undefined;
  tool_call: ToolCallResult | undefined;
  tool_result: ToolResultPatch | undefined;
  save_point: undefined;
  settled: undefined;
};
```

`src/harness/agent-harness.ts`:

```ts
import { Agent } from "../agent.js";
import type { AgentTool, ToolResult } from "../tools.js";
import type { AgentEvent, AgentMessage, UserMessage } from "../types.js";
import type { ExecutionEnv } from "./env.js";
import type { Session } from "./session.js";
import type {
  AgentHarnessEventResultMap,
  AgentHarnessOptions,
  AgentHarnessOwnEvent,
  AgentHarnessResources,
  Skill,
} from "./types.js";

type AnyEvent = AgentEvent | AgentHarnessOwnEvent;

export class AgentHarness {
  readonly agent: Agent;
  readonly env: ExecutionEnv;
  private session: Session;
  private model: AgentHarnessOptions["model"];
  private apiKey: string;
  private resources: AgentHarnessResources;
  private tools = new Map<string, AgentTool>();
  private activeToolNames: string[];
  private systemPrompt: AgentHarnessOptions["systemPrompt"];
  private phase: "idle" | "turn" | "compaction" = "idle";
  private listeners = new Set<(event: AnyEvent) => Promise<void> | void>();
  private hooks = new Map<keyof AgentHarnessEventResultMap, Set<(event: any) => Promise<any> | any>>();
  private pendingMessages: AgentMessage[] = [];

  constructor(options: AgentHarnessOptions) {
    this.env = options.env;
    this.session = options.session;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.resources = options.resources ?? {};
    this.systemPrompt = options.systemPrompt;
    for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);
    this.activeToolNames = [...this.tools.keys()];

    this.agent = new Agent({
      systemPrompt: "",  // filled by prepareNextTurn
      tools: [...this.tools.values()],
    });

    // Edge 1: rebuild context from the session before each turn.
    this.agent.prepareNextTurn = async () => {
      const ctx = await this.session.buildContext();
      const activeTools = this.activeToolNames
        .map((n) => this.tools.get(n))
        .filter((t): t is AgentTool => !!t);
      const sysPrompt = await this.resolveSystemPrompt(activeTools);
      return {
        context: { systemPrompt: sysPrompt, messages: ctx.messages, tools: activeTools },
        model: this.model,
      };
    };

    // Edge 2: let hooks rewrite the context just before the provider call.
    this.agent.transformContext = async (messages) => {
      const patched = await this.emitHook({ type: "context", messages: [...messages] });
      return patched?.messages ?? messages;
    };

    // Edge 3: let hooks veto a tool call.
    this.agent.beforeToolCall = async ({ toolCall, args }) => {
      const result = await this.emitHook({
        type: "tool_call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: args as Record<string, unknown>,
      });
      return result ? { block: result.block, reason: result.reason } : undefined;
    };

    // Edge 4: let hooks rewrite a tool result.
    this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
      const patch = await this.emitHook({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: args as Record<string, unknown>,
        content: result.content,
        isError,
      });
      return patch
        ? { content: patch.content, isError: patch.isError, terminate: patch.terminate }
        : undefined;
    };

    // Edge 5: persist messages, emit own events.
    this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  private async resolveSystemPrompt(activeTools: AgentTool[]): Promise<string> {
    if (typeof this.systemPrompt === "string") return this.systemPrompt;
    if (typeof this.systemPrompt === "function") {
      return await this.systemPrompt({
        env: this.env,
        session: this.session,
        model: this.model,
        activeTools,
        resources: this.resources,
      });
    }
    return "You are a helpful assistant.";
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    // Fan out to subscribers.
    for (const listener of this.listeners) await listener(event);

    if (event.type === "message_end") {
      // Persist every message as it's finalized.
      if (this.phase === "idle") {
        await this.session.appendMessage(event.message);
      } else {
        // During a turn, the harness will flush at turn_end.
        this.pendingMessages.push(event.message);
      }
    }

    if (event.type === "turn_end") {
      const hadPendingMutations = this.pendingMessages.length > 0;
      const toFlush = this.pendingMessages;
      this.pendingMessages = [];
      for (const message of toFlush) {
        await this.session.appendMessage(message);
      }
      await this.emitOwn({ type: "save_point", hadPendingMutations });
    }

    if (event.type === "agent_end") {
      this.phase = "idle";
      await this.emitOwn({ type: "settled" });
    }
  }

  private async emitOwn(event: AgentHarnessOwnEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  private async emitHook<T extends keyof AgentHarnessEventResultMap>(
    event: Extract<AgentHarnessOwnEvent, { type: T }>,
  ): Promise<AgentHarnessEventResultMap[T] | undefined> {
    const handlers = this.hooks.get(event.type as T);
    if (!handlers || handlers.size === 0) return undefined;
    let last: AgentHarnessEventResultMap[T] | undefined;
    for (const handler of handlers) {
      const result = await handler(event);
      if (result !== undefined) last = result;
    }
    return last;
  }

  // Public API ----------------------------------------------------------

  async prompt(text: string): Promise<void> {
    if (this.phase !== "idle") throw new Error("AgentHarness is busy");
    this.phase = "turn";
    const user: UserMessage = { role: "user", content: [{ type: "text", text }] };
    await this.session.appendMessage(user);
    try {
      await this.agent.prompt([user]);
    } finally {
      // safety: phase reset happens on agent_end too
      this.phase = "idle";
    }
  }

  subscribe(listener: (event: AnyEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  on<T extends keyof AgentHarnessEventResultMap>(
    type: T,
    handler: (event: Extract<AgentHarnessOwnEvent, { type: T }>) =>
      Promise<AgentHarnessEventResultMap[T]> | AgentHarnessEventResultMap[T],
  ): () => void {
    let handlers = this.hooks.get(type);
    if (!handlers) { handlers = new Set(); this.hooks.set(type, handlers); }
    handlers.add(handler as any);
    return () => handlers!.delete(handler as any);
  }

  abort(): Promise<void> {
    this.agent.abort();
    return this.agent.waitForIdle();
  }

  async setModel(model: AgentHarnessOptions["model"]): Promise<void> {
    this.model = model;
    await this.session.appendModelChange(model.provider, model.id);
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    const missing = toolNames.filter((n) => !this.tools.has(n));
    if (missing.length) throw new Error(`Unknown tools: ${missing.join(", ")}`);
    this.activeToolNames = [...toolNames];
  }
}
```

`main.ts` becomes:

```ts
import { NodeExecutionEnv } from "./harness/env.js";
import { InMemorySessionStorage } from "./harness/session-storage.js";
import { Session } from "./harness/session.js";
import { AgentHarness } from "./harness/agent-harness.js";
import {
  createBashTool, createEditTool, createFindTool,
  createGrepTool, createReadTool, createWriteTool,
} from "./coding-tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const session = new Session(new InMemorySessionStorage());

const tools = [
  createReadTool(env),
  createWriteTool(env),
  createEditTool(env),
  createBashTool(env),
  createGrepTool(env),
  createFindTool(env),
];

const harness = new AgentHarness({
  env,
  session,
  tools,
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: { provider: "anthropic", id: "claude-haiku-4-5" },
  systemPrompt: ({ activeTools, env }) =>
    buildSystemPrompt({
      cwd: env.cwd,
      selectedTools: activeTools.map((t) => t.name),
      toolSnippets: {
        read: "Read file contents",
        write: "Create or overwrite files",
        edit: "Make precise file edits",
        bash: "Execute bash commands",
        grep: "Search file contents",
        find: "Find files by glob",
      },
    }),
});

harness.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  else if (event.type === "message_end" && event.message.role === "assistant") process.stdout.write("\n");
});

await harness.prompt(process.argv.slice(2).join(" ") || "list the files in the current directory");
```

Notice what's gone from the application: there's no explicit
`messages` array, no `agent.state.systemPrompt` plumbing, no
`agent.subscribe` for save logic. The harness owns those edges.

> **pi-mono anchor**: `agent-harness.ts:147-248` (the constructor)
> and `:425-475` (the `executeTurn` private method) are the two
> places to compare against. The real version also threads
> `streamOptions`, `getApiKeyAndHeaders`, queue management
> (`steerQueue` / `followUpQueue` / `nextTurnQueue`), and a
> `pendingSessionWrites` buffer so the session stays consistent if
> a hook modifies state mid-turn.

---

## Phase 4 — Hooks: `tool_call`, `tool_result`, `context`, `save_point`

The `.on()` API is the application's main extension point. Four hooks
to get a feel for what's possible:

### 4a — Permissions via `tool_call`

```ts
harness.on("tool_call", async (event) => {
  if (event.toolName === "bash") {
    const cmd = (event.input.command ?? "") as string;
    if (cmd.match(/\brm\b|--force|sudo/)) {
      return { block: true, reason: "Blocked: destructive command" };
    }
  }
  return undefined;
});
```

`block: true` causes the agent loop to skip `execute`. The tool
result that comes back to the model is `[isError: true, content:
"Blocked: …"]` — exactly the same shape the model sees for a normal
error, which is what you want: the model retries or asks for
permission instead of getting confused by an unexpected event.

### 4b — Output redaction via `tool_result`

```ts
harness.on("tool_result", async (event) => {
  if (event.toolName !== "read") return undefined;
  const redacted = event.content.map((c) => ({
    ...c,
    text: c.text.replace(/sk-ant-[A-Za-z0-9-]+/g, "sk-ant-***REDACTED***"),
  }));
  return { content: redacted };
});
```

The hook returns a patch — `content` only, leaving `isError` and
`terminate` alone. The agent loop applies the patch before the result
ever lands in `messages`, so the redacted version is what the model
sees and what the session stores.

### 4c — Context pruning via `context`

```ts
harness.on("context", async ({ messages }) => {
  // Cap the number of tool results we send. Keep the last 8.
  const toolResultIndices = messages
    .map((m, i) => (m.role === "toolResult" ? i : -1))
    .filter((i) => i >= 0);
  if (toolResultIndices.length <= 8) return { messages };
  const dropBefore = toolResultIndices[toolResultIndices.length - 8];
  return { messages: messages.slice(dropBefore) };
});
```

This fires after `prepareNextTurn` rebuilt context from the session
and before the provider sees the messages — a perfect place for
custom pruning that doesn't deserve a full compaction.

### 4d — Watching for `save_point`

```ts
harness.on("save_point", (event) => {
  if (event.hadPendingMutations) console.error("[turn flushed to session]");
});
```

`save_point` fires once per turn, after the harness has appended all
of that turn's messages to the session. It is the right place to
trigger an external snapshot (commit the session JSONL, push to a
remote backup, etc.).

Test each hook by registering it before `harness.prompt(…)` and
verifying the printed behavior. Hooks compose: register both `4b` and
`4a` and you get redacted output plus blocked commands. The last
registered handler wins for return values; all handlers run for
side effects.

> **pi-mono anchor**: `agent-harness.ts:262-310` (the `emitHook`,
> `emitBeforeProviderRequest`, and `emitBeforeProviderPayload`
> internals). The real surface adds `before_provider_request`,
> `before_provider_payload`, `after_provider_response`,
> `before_agent_start`, and several compaction-related hooks. The
> shape — handlers can return `undefined` to opt out — is the same.

---

## Phase 5 — Skills

A **skill** is a markdown file with frontmatter that the model can
read when its task matches the description. Skills are surfaced two
ways:

1. **In the system prompt** — the harness lists them in an
   `<available_skills>` XML block so the model can mention them in
   reasoning and then read the full file with `read`.
2. **By explicit invocation** — the application calls
   `harness.skill("name")` and the harness drops the full skill
   content into a user message that starts the turn.

### Loader

`src/harness/skills.ts`:

```ts
import { parse } from "yaml";
import type { ExecutionEnv } from "./env.js";
import type { Skill } from "./types.js";

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

function parseFrontmatter<T>(content: string): { frontmatter: T; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {} as T, body: normalized };
  return {
    frontmatter: (parse(normalized.slice(4, end)) ?? {}) as T,
    body: normalized.slice(end + 4).trim(),
  };
}

export async function loadSkills(env: ExecutionEnv, dir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  if (!(await env.exists(dir))) return skills;

  const entries = await env.listDir(dir);
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const skillPath = `${entry.path}/SKILL.md`;
    if (!(await env.exists(skillPath))) continue;
    const raw = await env.readTextFile(skillPath);
    const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw);
    if (!frontmatter.description) continue;
    skills.push({
      name: frontmatter.name ?? entry.name,
      description: frontmatter.description,
      content: body,
      filePath: skillPath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    });
  }
  return skills;
}

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escape(s.name)}</name>`);
    lines.push(`    <description>${escape(s.description)}</description>`);
    lines.push(`    <location>${escape(s.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillInvocation(skill: Skill, extra?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`;
  return extra ? `${block}\n\n${extra}` : block;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
```

### Wiring

Two changes to `AgentHarness`:

```ts
// inside resolveSystemPrompt, after the user's callback returns:
const skillsBlock = formatSkillsForSystemPrompt(this.resources.skills ?? []);
return skillsBlock ? `${prompt}\n\n${skillsBlock}` : prompt;
```

```ts
// new public method
async skill(name: string, extra?: string): Promise<void> {
  const skill = (this.resources.skills ?? []).find((s) => s.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  await this.prompt(formatSkillInvocation(skill, extra));
}
```

### Example skill

```md
<!-- ./skills/run-tests/SKILL.md -->
---
name: run-tests
description: Run the test suite and report failures. Use when the user asks to run, fix, or investigate tests.
---

When invoked:
1. Run `npm test -- --reporter=json` via the `bash` tool.
2. Parse the failing test names.
3. For each failure, read the test file and the file under test, then propose a fix.
```

Wire it up:

```ts
const skills = await loadSkills(env, "./skills");
const harness = new AgentHarness({ env, session, tools, apiKey, model, resources: { skills }, systemPrompt });
await harness.skill("run-tests", "Focus on the parser tests");
```

The model sees the skill listed in the system prompt and can also be
invoked directly through `harness.skill(...)`.

> **pi-mono anchor**: `harness/skills.ts:40-220` (the real loader
> also walks subdirectories, honors `.gitignore` / `.ignore` /
> `.fdignore`, emits diagnostics for malformed files, and supports
> `loadSourcedSkills` for tagging skills with provenance), and the
> system-prompt format at `harness/system-prompt.ts:3-25`.

---

## Phase 6 — Prompt templates

A **prompt template** is a markdown file whose body is a parameterized
prompt. Calls look like `harness.promptFromTemplate("review-pr",
["#1234"])`. The body uses `$1`, `$2`, `$@`, `$ARGUMENTS`, and
`${@:N:L}` placeholders.

`src/harness/prompt-templates.ts`:

```ts
import { parse } from "yaml";
import type { ExecutionEnv, FileInfo } from "./env.js";
import type { PromptTemplate } from "./types.js";

interface TemplateFrontmatter {
  description?: string;
  "argument-hint"?: string;
}

function parseFrontmatter<T>(content: string): { frontmatter: T; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {} as T, body: normalized };
  return {
    frontmatter: (parse(normalized.slice(4, end)) ?? {}) as T,
    body: normalized.slice(end + 4).trim(),
  };
}

export async function loadPromptTemplates(env: ExecutionEnv, dir: string): Promise<PromptTemplate[]> {
  if (!(await env.exists(dir))) return [];
  const entries = (await env.listDir(dir)).filter((e): e is FileInfo =>
    e.kind === "file" && e.name.endsWith(".md"),
  );
  const out: PromptTemplate[] = [];
  for (const entry of entries) {
    const raw = await env.readTextFile(entry.path);
    const { frontmatter, body } = parseFrontmatter<TemplateFrontmatter>(raw);
    const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
    out.push({
      name: entry.name.replace(/\.md$/, ""),
      description: frontmatter.description || firstLine.slice(0, 60),
      content: body,
    });
  }
  return out;
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, n: string) => args[parseInt(n, 10) - 1] ?? "");
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, sStr: string, lStr?: string) => {
    const start = Math.max(0, parseInt(sStr, 10) - 1);
    if (lStr) return args.slice(start, start + parseInt(lStr, 10)).join(" ");
    return args.slice(start).join(" ");
  });
  const all = args.join(" ");
  return result.replace(/\$ARGUMENTS/g, all).replace(/\$@/g, all);
}

export function formatPromptTemplateInvocation(t: PromptTemplate, args: string[] = []): string {
  return substituteArgs(t.content, args);
}
```

Add the harness method:

```ts
async promptFromTemplate(name: string, args: string[] = []): Promise<void> {
  const template = (this.resources.promptTemplates ?? []).find((t) => t.name === name);
  if (!template) throw new Error(`Unknown prompt template: ${name}`);
  await this.prompt(formatPromptTemplateInvocation(template, args));
}
```

A small REPL trick — turn a `/review-pr 1234` style command into a
prompt-template call:

```ts
const text = await rl.question("\n› ");
if (text.startsWith("/")) {
  const [name, ...rest] = text.slice(1).split(/\s+/);
  await harness.promptFromTemplate(name, rest);
} else {
  await harness.prompt(text);
}
```

> **pi-mono anchor**: `harness/prompt-templates.ts:108-225`. The real
> version also supports directory inputs, file inputs, recursive
> loading, and `loadSourcedPromptTemplates` for tagging.

---

## Phase 7 — Compaction

The hardest phase. Goal: when the context tokens approach the model's
window, summarize the older turns into a single message and rebuild
context from "summary + recent turns" instead of "everything."

The harness does four things on compaction:

1. **Detect** that compaction is needed (a check before each turn, or
   on a hook trigger).
2. **Find a cut point** — walk backwards from the most recent message,
   accumulating estimated tokens, stop when "kept tokens" hit a budget
   (default 20k). Cut at a user or assistant message boundary; never
   in the middle of a tool call/result pair.
3. **Summarize** the messages before the cut with a separate LLM
   call. The summary follows a structured format (Goal / Progress /
   Decisions / Next Steps).
4. **Append a `CompactionEntry`** to the session pointing at the
   first kept entry. Next time `buildContext` runs, it sees the
   compaction and rebuilds context as `[summary as user message,
   then everything from firstKeptEntryId forward]`.

### Estimation

`src/harness/compaction.ts`:

```ts
import type { Model } from "../provider.js";
import type {
  AgentMessage, AssistantMessage, ToolResultMessage, UserMessage,
} from "../types.js";

export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  if (message.role === "user") {
    const content = (message as UserMessage).content;
    for (const block of content) if (block.type === "text") chars += block.text.length;
  } else if (message.role === "assistant") {
    for (const block of (message as AssistantMessage).content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  } else if (message.role === "toolResult") {
    for (const block of (message as ToolResultMessage).content) chars += block.text.length;
  }
  return Math.ceil(chars / 4);
}

export function estimateContextTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}
```

### Cut point

```ts
import type { SessionTreeEntry } from "./session-storage.js";

export interface CutPoint {
  firstKeptEntryIndex: number;
}

export function findCutPoint(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPoint {
  let accumulated = 0;
  let cutIndex = startIndex;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    accumulated += estimateTokens(entry.message);
    if (accumulated >= keepRecentTokens) {
      // Walk forward to a user-message boundary so we don't split a tool call/result pair.
      for (let c = i; c < endIndex; c++) {
        const e = entries[c];
        if (e.type === "message" && e.message.role === "user") { cutIndex = c; break; }
      }
      break;
    }
  }
  return { firstKeptEntryIndex: cutIndex };
}
```

The real implementation handles more cases (compaction nested inside
prior compactions, split turns, bash-execution boundaries), but the
shape is the same.

### Summary call

```ts
import Anthropic from "@anthropic-ai/sdk";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed work]
### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Anything else needed to continue]

Keep each section concise. Preserve exact file paths and function names.`;

export async function generateSummary(
  messagesToSummarize: AgentMessage[],
  model: Model,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const lines: string[] = [];
  for (const m of messagesToSummarize) {
    if (m.role === "user") {
      const text = (m as UserMessage).content.filter((c) => c.type === "text").map((c) => c.text).join("");
      lines.push(`USER: ${text}`);
    } else if (m.role === "assistant") {
      const a = m as AssistantMessage;
      for (const block of a.content) {
        if (block.type === "text") lines.push(`ASSISTANT: ${block.text}`);
        else if (block.type === "toolCall") lines.push(`ASSISTANT [tool: ${block.name}] ${JSON.stringify(block.arguments).slice(0, 200)}`);
      }
    } else if (m.role === "toolResult") {
      const text = (m as ToolResultMessage).content.map((c) => c.text).join("").slice(0, 2000);
      lines.push(`TOOL RESULT: ${text}`);
    }
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model: model.id,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `<conversation>\n${lines.join("\n")}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
      }],
    },
    { signal },
  );
  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
```

### Wire-up

Add to `AgentHarness`:

```ts
async compact(): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }> {
  if (this.phase !== "idle") throw new Error("compact() requires idle harness");
  this.phase = "compaction";
  try {
    const entries = await this.session.getBranch();
    const context = await this.session.buildContext();
    const tokensBefore = estimateContextTokens(context.messages);

    const cut = findCutPoint(entries, 0, entries.length, 20_000);
    const messagesToSummarize: AgentMessage[] = [];
    for (let i = 0; i < cut.firstKeptEntryIndex; i++) {
      const entry = entries[i];
      if (entry.type === "message") messagesToSummarize.push(entry.message);
    }
    if (messagesToSummarize.length === 0) {
      this.phase = "idle";
      return { summary: "", firstKeptEntryId: entries[0]?.id ?? "", tokensBefore };
    }
    const summary = await generateSummary(messagesToSummarize, this.model, this.apiKey);
    const firstKeptEntryId = entries[cut.firstKeptEntryIndex].id;
    await this.session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
    return { summary, firstKeptEntryId, tokensBefore };
  } finally {
    this.phase = "idle";
  }
}
```

And an auto-trigger:

```ts
this.agent.transformContext = async (messages) => {
  const patched = await this.emitHook({ type: "context", messages: [...messages] });
  const effective = patched?.messages ?? messages;
  if (estimateContextTokens(effective) > 180_000 && this.phase !== "compaction") {
    // Defer: schedule compaction for the next idle, don't recurse mid-turn.
    queueMicrotask(() => { void this.compact(); });
  }
  return effective;
};
```

Test it manually: enqueue a giant prompt, observe a `compaction`
entry append to the session, then prompt again and confirm the new
context starts with the summary as a user message followed by recent
turns only.

> **pi-mono anchor**: `harness/compaction/compaction.ts:226-700`. The
> real version handles split turns (cut point not at a user-message
> boundary), iterative update prompts (when a session has already
> been compacted), turn-prefix summarization, parallel summary
> generation, and `details: { readFiles, modifiedFiles }` so the
> summary always includes a file-touched manifest.

---

## Phase 8 — Steering and the next-turn queue

The `Agent` from tutorial 1 already supports `steer`, `followUp`, and
queued user messages. The harness adds two things:

1. **Authoritative queues** for use from the application. The
   harness's `steer()` /`followUp()` / `nextTurn()` methods push to
   the harness queue *and* to the agent queue, so the application can
   see what's pending without poking at agent internals.
2. **A `queue_update` event** every time a queue changes, so the TUI
   can render a "queued" badge next to the input.

Slice of the wire-up (extend `AgentHarness`):

```ts
private steerQueue: UserMessage[] = [];
private followUpQueue: UserMessage[] = [];
private nextTurnQueue: UserMessage[] = [];

steer(text: string): void {
  if (this.phase === "idle") throw new Error("Cannot steer while idle");
  const msg: UserMessage = { role: "user", content: [{ type: "text", text }] };
  this.steerQueue.push(msg);
  this.agent.steer(msg);
  void this.emitOwn({ type: "queue_update",
    steer: [...this.steerQueue], followUp: [...this.followUpQueue], nextTurn: [...this.nextTurnQueue] });
}

nextTurn(text: string): void {
  this.nextTurnQueue.push({ role: "user", content: [{ type: "text", text }] });
  void this.emitOwn({ type: "queue_update",
    steer: [...this.steerQueue], followUp: [...this.followUpQueue], nextTurn: [...this.nextTurnQueue] });
}
```

When the next turn starts, drain `nextTurnQueue` into the prompt that
the user just typed (the real harness in `executeTurn` does this on
line 432 of `agent-harness.ts`):

```ts
async prompt(text: string): Promise<void> {
  // ...
  let messages: UserMessage[] = [{ role: "user", content: [{ type: "text", text }] }];
  if (this.nextTurnQueue.length > 0) {
    messages = [...this.nextTurnQueue, messages[0]!];
    this.nextTurnQueue = [];
  }
  for (const m of messages) await this.session.appendMessage(m);
  await this.agent.prompt(messages);
}
```

The application contract becomes: anything typed while the agent is
idle is a `prompt`. Anything typed while the agent is streaming is a
`steer`. Anything typed *after* aborting goes into the next prompt
automatically.

> **pi-mono anchor**: `agent-harness.ts:505-525` for the public
> queue API and `:392-410` for the queue clearing on
> `message_start`.

---

## Phase 9 — JSONL session persistence

The in-memory storage from Phase 2 has the right shape but vanishes
on exit. Pi-mono's storage is JSONL: each `appendEntry` writes one
line; `getEntries` reads the file once at startup and rebuilds the
`byId` map.

`src/harness/jsonl-storage.ts` (sketch — file I/O slice only):

```ts
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SessionMetadata, SessionStorage, SessionTreeEntry } from "./session-storage.js";

interface JsonlHeader {
  type: "session_header";
  id: string;
  createdAt: string;
  cwd: string;
}

export class JsonlSessionStorage implements SessionStorage {
  private metadata!: SessionMetadata;
  private entries: SessionTreeEntry[] = [];
  private byId = new Map<string, SessionTreeEntry>();
  private leafId: string | null = null;
  private leafFile: string;

  constructor(private path: string) { this.leafFile = `${path}.leaf`; }

  async open(cwd: string): Promise<void> {
    try {
      const content = await readFile(this.path, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]) as JsonlHeader;
      this.metadata = { id: header.id, createdAt: header.createdAt };
      for (const line of lines.slice(1)) {
        const entry = JSON.parse(line) as SessionTreeEntry;
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
      }
      try {
        this.leafId = (await readFile(this.leafFile, "utf8")).trim() || null;
      } catch {
        this.leafId = this.entries[this.entries.length - 1]?.id ?? null;
      }
    } catch {
      this.metadata = { id: randomUUID(), createdAt: new Date().toISOString() };
      const header: JsonlHeader = { type: "session_header", ...this.metadata, cwd };
      await writeFile(this.path, `${JSON.stringify(header)}\n`);
    }
  }

  async getMetadata() { return this.metadata; }
  async getLeafId() { return this.leafId; }
  async setLeafId(leafId: string | null) {
    this.leafId = leafId;
    await writeFile(this.leafFile, leafId ?? "");
  }
  async createEntryId() {
    for (let i = 0; i < 100; i++) {
      const id = randomUUID().slice(0, 8);
      if (!this.byId.has(id)) return id;
    }
    return randomUUID();
  }
  async appendEntry(entry: SessionTreeEntry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    this.leafId = entry.id;
    await writeFile(this.leafFile, entry.id);
  }
  async getEntry(id: string) { return this.byId.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let cur = this.byId.get(leafId);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return path;
  }
  async getEntries() { return [...this.entries]; }
}
```

Boot it from `main.ts`:

```ts
const storage = new JsonlSessionStorage(`./.pi-sessions/${Date.now()}.jsonl`);
await storage.open(env.cwd);
const session = new Session(storage);
```

Now a `Ctrl-C` followed by a relaunch picks up the same conversation:
`prepareNextTurn` walks the same tree, the model sees the same
history, and the next message tacks onto the end of the same file.

A useful follow-on: list sessions on disk, pick one to resume, fork a
session from any entry. Those are all just additional methods on a
`SessionRepo` interface that wraps the storage.

> **pi-mono anchor**:
> `packages/agent/src/harness/session/storage/jsonl.ts` and
> `packages/agent/src/harness/session/repo/jsonl.ts`. The real
> implementations use uuidv7 IDs (lexicographically sortable),
> write-ahead a `.leaf` sidecar, and handle session forking by
> copying the path-to-root entries into a new file.

---

## Phase 10 — Putting it all together

A complete `main.ts` that uses every piece:

```ts
import { createInterface } from "node:readline/promises";
import { NodeExecutionEnv } from "./harness/env.js";
import { JsonlSessionStorage } from "./harness/jsonl-storage.js";
import { Session } from "./harness/session.js";
import { AgentHarness } from "./harness/agent-harness.js";
import { loadSkills, formatSkillsForSystemPrompt } from "./harness/skills.js";
import { loadPromptTemplates } from "./harness/prompt-templates.js";
import {
  createBashTool, createEditTool, createFindTool,
  createGrepTool, createReadTool, createWriteTool,
} from "./coding-tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const sessionPath = process.env.PI_SESSION_PATH ?? `./.pi-sessions/${Date.now()}.jsonl`;
const storage = new JsonlSessionStorage(sessionPath);
await storage.open(env.cwd);
const session = new Session(storage);

const skills = await loadSkills(env, "./skills");
const promptTemplates = await loadPromptTemplates(env, "./prompts");

const harness = new AgentHarness({
  env, session,
  tools: [
    createReadTool(env), createWriteTool(env), createEditTool(env),
    createBashTool(env), createGrepTool(env), createFindTool(env),
  ],
  resources: { skills, promptTemplates },
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: { provider: "anthropic", id: "claude-haiku-4-5" },
  systemPrompt: async ({ activeTools, env, resources }) => {
    const base = buildSystemPrompt({
      cwd: env.cwd,
      selectedTools: activeTools.map((t) => t.name),
      toolSnippets: {
        read: "Read file contents",
        write: "Create or overwrite files",
        edit: "Make precise file edits",
        bash: "Execute bash commands",
        grep: "Search file contents",
        find: "Find files by glob",
      },
    });
    const skillsBlock = formatSkillsForSystemPrompt(resources.skills ?? []);
    return skillsBlock ? `${base}\n\n${skillsBlock}` : base;
  },
});

// Block destructive bash commands.
harness.on("tool_call", async (event) => {
  if (event.toolName === "bash" && /\brm\b|--force|sudo/.test(String(event.input.command ?? ""))) {
    return { block: true, reason: "Blocked: destructive command" };
  }
  return undefined;
});

// Redact API keys from any tool output.
harness.on("tool_result", async (event) => ({
  content: event.content.map((c) => ({ ...c, text: c.text.replace(/sk-ant-[A-Za-z0-9-]+/g, "sk-ant-***") })),
}));

// Stream tokens to stdout.
harness.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  else if (event.type === "message_end" && event.message.role === "assistant") process.stdout.write("\n");
  else if (event.type === "save_point" && event.hadPendingMutations) process.stderr.write(`[saved to ${sessionPath}]\n`);
});

process.on("SIGINT", () => {
  if (harness.agent.isStreaming) void harness.abort();
  else process.exit(0);
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
while (true) {
  const text = (await rl.question("\n› ")).trim();
  if (!text) continue;
  if (text === "/quit") break;
  if (text === "/compact") { console.log(await harness.compact()); continue; }
  if (text.startsWith("/skill ")) { await harness.skill(text.slice(7).trim()); continue; }
  if (text.startsWith("/")) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    await harness.promptFromTemplate(name, rest);
    continue;
  }
  await harness.prompt(text);
}
rl.close();
```

What you can do with this REPL:

- Type `find every TODO comment and write them to TODOS.md` — the
  agent uses `grep` + `write`, the session persists every step, and
  re-launching with `PI_SESSION_PATH` resumes mid-task.
- Type `/run-tests` — the prompt template (or skill) replaces the
  literal text the model sees with the full template content.
- Type `/compact` after a long session — the older turns get
  summarized; the next prompt sees a compact context.
- `Ctrl-C` aborts the in-flight stream without exiting; a second
  `Ctrl-C` quits.

---

## Phase 11 — What you have now

You added roughly 800–1200 lines on top of tutorial 2, in three
layers:

**Execution environment**
- `harness/env.ts` — portable filesystem + shell interface, a
  `NodeExecutionEnv` implementation, refactored tools

**Session**
- `harness/messages.ts` — extra message roles (`compactionSummary`,
  `branchSummary`)
- `harness/session-storage.ts` — `SessionStorage` interface, in-memory
  implementation, JSONL implementation
- `harness/session.ts` — `Session` class with `buildContext`

**Harness**
- `harness/types.ts` — types for skills, templates, hooks, events
- `harness/agent-harness.ts` — the `AgentHarness` class wrapping
  `Agent` via `prepareNextTurn`, `transformContext`,
  `beforeToolCall`, `afterToolCall`
- `harness/skills.ts` — loader, system-prompt formatter, explicit
  invocation
- `harness/prompt-templates.ts` — loader + argument substitution
- `harness/compaction.ts` — token estimation, cut-point detection,
  summary generation, `compact()` method

What pi-mono does on top:

| Feature | Where in pi-mono | What you'd add |
| --- | --- | --- |
| Multiple providers | `packages/ai/src/api-registry.ts` | Same registry exercise from tutorial 1 |
| Per-turn stream options + auth headers | `agent-harness.ts:147-188` | A `getApiKeyAndHeaders` callback + a `streamOptions` slot |
| `before_provider_request` / `before_provider_payload` / `after_provider_response` hooks | `agent-harness.ts:277-310` | Patch outgoing headers, log full payloads, observe response status |
| Branch navigation + branch summary | `agent-harness.ts:584-691` | Walk to any historical entry, optionally summarize the abandoned branch |
| Custom message and entry types | `Session.appendCustomMessageEntry` / `appendCustomEntry` | UI-only messages that the model never sees |
| Sourced skills / prompt templates with provenance tags | `harness/skills.ts:62-80` | Tag each skill with a source so UIs can group "system" vs. "project" skills |
| Iterative compaction updates | `compaction.ts:494-531` | When a session already has a compaction summary, *update* it instead of regenerating from scratch |
| Turn-prefix summarization | `compaction.ts:705-855` | If the cut falls mid-turn, summarize the prefix separately so the suffix retains context |
| Forkable sessions | `session/repo/jsonl.ts` | Pick any entry, create a new session starting from that entry's path |
| Compaction details: read-files / modified-files manifest | `compaction/utils.ts:62-82` | Append `<read-files>` / `<modified-files>` XML to every summary |

Extracting your harness into its own package, layering a session-tree
TUI on top of the `ChatLog` from tutorial 2, and adding a permissions
layer that prompts the user before destructive tool calls — that's
roughly the boundary between this tutorial and the
`packages/agent/src/harness` directory in the real repo.

## Suggested verification along the way

| Phase | Test |
| --- | --- |
| 1 | Replace `fs/promises` calls in `read.ts` with `env.readTextFile`; the existing `read({ path: "package.json" })` returns the same content |
| 2 | Append two messages, walk `getBranch()`, observe a two-entry chain; `buildContext()` returns those two messages with no compaction noise |
| 3 | `harness.prompt("ping")` produces an assistant message and a `save_point` event; a *second* `harness.prompt(...)` sees the first in its context (the model can reference it) |
| 4 | Register `tool_call` hook returning `{ block: true }` for `bash`; observe the model see an error result, retry with `read`, and continue without aborting the turn |
| 5 | Write a `SKILL.md` with frontmatter, call `harness.skill("name")`, and observe the model's first message reference the skill body |
| 6 | Write `prompts/echo.md` with body `Echo: $1`, call `promptFromTemplate("echo", ["hi"])`, observe the model receive `"Echo: hi"` |
| 7 | Force `estimateContextTokens` past your threshold, call `harness.compact()`, observe a `compaction` entry appended and the next turn's context start with a summary |
| 8 | Call `harness.steer("focus on auth.ts")` while the agent is streaming; the next turn-event has the steer message in `messages` |
| 9 | Launch, prompt, `Ctrl-C`. Relaunch with `PI_SESSION_PATH=…`; the next prompt continues from where you left off |
| 10 | Type `/compact`, `/skill run-tests`, `/echo hello`, and observe each route to the right method |

If a phase misbehaves, log the session entries (`await session.getEntries()`) and the harness event stream side-by-side. Every interesting state transition is either an entry append or a named event — just like the real harness.
