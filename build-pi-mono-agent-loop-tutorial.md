# Tutorial: Build a pi-mono-style Agentic Loop

A hands-on rebuild of the orchestration documented in
`prompt-resolution-flow.md`. By the end you will have a small library that
mirrors pi-mono's core abstractions:

- A **provider event stream** (`text_delta`, `toolcall_delta`, `done`, …)
- An **agent loop** that emits `turn_start` / `turn_end`, runs tools, and
  loops until the model stops calling tools
- An **AgentMessage** boundary with a `convertToLlm` step for custom
  message types
- A stateful **Agent class** with `subscribe`, `prompt`, `continue`,
  `abort`, steering, and follow-up queues
- **`beforeToolCall` / `afterToolCall` hooks** and a `terminate` hint

Build it phase by phase. Every phase is runnable on its own, so you can
verify progress as you go.

> Targets a single provider — Anthropic's Messages API — to keep the focus
> on orchestration. Adding more providers is a registry exercise we leave
> to the end.

---

## Phase 0 — Project setup

```bash
mkdir my-agent && cd my-agent
npm init -y
npm install @anthropic-ai/sdk
npm install -D typescript tsx @types/node
npx tsc --init --rootDir src --outDir dist --module nodenext --target es2022 --moduleResolution nodenext --esModuleInterop --strict --skipLibCheck
mkdir src
```

Add a script in `package.json`:

```json
{
  "scripts": {
    "dev": "tsx src/main.ts"
  },
  "type": "module"
}
```

Export your key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Final folder layout we are aiming at:

```
src/
  types.ts        # message + event types
  provider.ts     # streamAnthropic — raw provider stream
  agent-loop.ts   # runAgentLoop — orchestration
  agent.ts        # Agent class — stateful wrapper
  tools.ts        # sample tools
  main.ts         # entry point
```

---

## Phase 1 — Hello, streaming model

Goal: make a single streaming call and print tokens. This is the smallest
provider call that pi-mono's `streamAnthropic` later wraps.

`src/main.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 256,
  messages: [{ role: "user", content: "Say hi in one sentence." }],
  stream: true,
});

for await (const event of response) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}
process.stdout.write("\n");
```

Run it:

```bash
npm run dev
```

You should see streamed text. We will now wrap this into a normalized
event stream.

---

## Phase 2 — A normalized provider event stream

pi-mono's providers emit a small standard vocabulary (`start`,
`text_start/delta/end`, `toolcall_start/delta/end`, `thinking_*`, `done`,
`error`) plus a `partial` snapshot of the assistant message so far. We do
the same here, minus thinking.

`src/types.ts`:

```ts
export type TextContent = { type: "text"; text: string };

export type ToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultContent = {
  type: "toolResult";
  toolCallId: string;
  content: TextContent[];
  isError?: boolean;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextContent | ToolCallContent>;
  stopReason: "stop" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
};

export type UserMessage = {
  role: "user";
  content: TextContent[];
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
};

export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "toolcall_start"; partial: AssistantMessage }
  | { type: "toolcall_delta"; partial: AssistantMessage }
  | { type: "toolcall_end"; partial: AssistantMessage }
  | { type: "done"; partial: AssistantMessage }
  | { type: "error"; error: Error; partial: AssistantMessage };
```

`src/provider.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, AssistantStreamEvent, LlmMessage } from "./types.js";

const client = new Anthropic();

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export async function* streamAnthropic(
  systemPrompt: string,
  messages: LlmMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): AsyncGenerator<AssistantStreamEvent, AssistantMessage> {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    stopReason: "stop",
  };

  yield { type: "start", partial };

  // Translate our LlmMessage[] to Anthropic's MessageParam[]
  const apiMessages = messages.map(toApiMessage);

  try {
    const response = await client.messages.stream(
      {
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: apiMessages,
        tools: tools.length ? tools : undefined,
      },
      { signal },
    );

    let toolJsonBuf = "";
    let currentBlockIndex = -1;

    for await (const event of response) {
      if (event.type === "content_block_start") {
        currentBlockIndex = event.index;
        if (event.content_block.type === "text") {
          partial.content.push({ type: "text", text: "" });
        } else if (event.content_block.type === "tool_use") {
          toolJsonBuf = "";
          partial.content.push({
            type: "toolCall",
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: {},
          });
          yield { type: "toolcall_start", partial };
        }
      } else if (event.type === "content_block_delta") {
        const block = partial.content[currentBlockIndex];
        if (event.delta.type === "text_delta" && block.type === "text") {
          block.text += event.delta.text;
          yield { type: "text_delta", delta: event.delta.text, partial };
        } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
          toolJsonBuf += event.delta.partial_json;
          yield { type: "toolcall_delta", partial };
        }
      } else if (event.type === "content_block_stop") {
        const block = partial.content[currentBlockIndex];
        if (block.type === "toolCall") {
          block.arguments = toolJsonBuf ? JSON.parse(toolJsonBuf) : {};
          yield { type: "toolcall_end", partial };
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason === "tool_use") partial.stopReason = "tool_use";
        else if (event.delta.stop_reason === "end_turn") partial.stopReason = "stop";
      }
    }

    yield { type: "done", partial };
    return partial;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    partial.stopReason = signal?.aborted ? "aborted" : "error";
    partial.errorMessage = error.message;
    yield { type: "error", error, partial };
    return partial;
  }
}

function toApiMessage(m: LlmMessage): Anthropic.MessageParam {
  if (m.role === "user") {
    return { role: "user", content: m.content.map((c) => ({ type: "text", text: c.text })) };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content.map((c) =>
        c.type === "text"
          ? { type: "text" as const, text: c.text }
          : { type: "tool_use" as const, id: c.id, name: c.name, input: c.arguments },
      ),
    };
  }
  // toolResult role becomes a user message containing tool_result blocks
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        is_error: m.isError,
        content: m.content.map((c) => ({ type: "text" as const, text: c.text })),
      },
    ],
  };
}
```

Update `src/main.ts` to consume the new stream:

```ts
import { streamAnthropic } from "./provider.js";

const stream = streamAnthropic(
  "You are concise.",
  [{ role: "user", content: [{ type: "text", text: "Say hi." }] }],
  [],
);

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "done") process.stdout.write("\n[done]\n");
}
```

Key idea: **the provider emits a tight, framework-agnostic vocabulary**.
The agent loop only ever sees these events.

---

## Phase 3 — The agent loop skeleton

We now build `runAgentLoop`, which adds a higher-level event stream:
`agent_start`, `turn_start`, `message_start`, `message_update`,
`message_end`, `turn_end`, `agent_end`.

`src/agent-loop.ts`:

```ts
import { streamAnthropic, type ToolDef } from "./provider.js";
import type {
  AssistantMessage,
  AssistantStreamEvent,
  LlmMessage,
  ToolResultMessage,
} from "./types.js";

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: LlmMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: LlmMessage }
  | { type: "message_update"; message: AssistantMessage; assistantEvent: AssistantStreamEvent }
  | { type: "message_end"; message: LlmMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage };

export type AgentContext = {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: ToolDef[];
};

export type AgentLoopConfig = {
  // Hooks added in later phases
};

export async function* runAgentLoop(
  prompts: LlmMessage[],
  context: AgentContext,
  _config: AgentLoopConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, LlmMessage[]> {
  const newMessages: LlmMessage[] = [...prompts];
  context.messages.push(...prompts);

  yield { type: "agent_start" };
  yield { type: "turn_start" };

  for (const prompt of prompts) {
    yield { type: "message_start", message: prompt };
    yield { type: "message_end", message: prompt };
  }

  while (true) {
    const assistant = yield* streamAssistant(context, signal);
    context.messages.push(assistant);
    newMessages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length === 0) {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    // Tool execution lives in Phase 4. For now, exit the loop.
    yield { type: "turn_end", message: assistant, toolResults: [] };
    break;
  }

  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* streamAssistant(
  context: AgentContext,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const stream = streamAnthropic(context.systemPrompt, context.messages, context.tools, signal);
  let started = false;
  let finalMessage: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === "start") {
      started = true;
      yield { type: "message_start", message: event.partial };
    } else if (event.type === "done" || event.type === "error") {
      finalMessage = event.partial;
    } else {
      yield { type: "message_update", message: event.partial, assistantEvent: event };
    }
  }

  if (!finalMessage) throw new Error("Provider stream ended with no final message");
  if (!started) yield { type: "message_start", message: finalMessage };
  yield { type: "message_end", message: finalMessage };
  return finalMessage;
}
```

Update `main.ts`:

```ts
import { runAgentLoop } from "./agent-loop.js";

const stream = runAgentLoop(
  [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
  { systemPrompt: "You are concise.", messages: [], tools: [] },
);

for await (const event of stream) {
  if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
    process.stdout.write(event.assistantEvent.delta);
  }
  if (event.type === "agent_end") process.stdout.write("\n[agent_end]\n");
}
```

You now have the same outer envelope pi-mono uses: `agent_start` →
`turn_start` → user `message_start/end` → assistant `message_start` +
streamed updates + `message_end` → `turn_end` → `agent_end`.

---

## Phase 4 — Tools

We add tools, a sequential executor, and the surrounding events.

`src/tools.ts`:

```ts
import type { TextContent } from "./types.js";

export type ToolResult = { content: TextContent[]; details?: unknown; terminate?: boolean };

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (args: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};

export const getTimeTool: AgentTool = {
  name: "get_time",
  description: "Return the current UTC time.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
  }),
};

export const addTool: AgentTool = {
  name: "add",
  description: "Add two numbers.",
  input_schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  execute: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { content: [{ type: "text", text: String(a + b) }] };
  },
};
```

Replace `agent-loop.ts` with the tool-aware version:

```ts
import { streamAnthropic } from "./provider.js";
import type { AgentTool, ToolResult } from "./tools.js";
import type {
  AssistantMessage,
  AssistantStreamEvent,
  LlmMessage,
  ToolResultMessage,
} from "./types.js";

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: LlmMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: LlmMessage }
  | { type: "message_update"; message: AssistantMessage; assistantEvent: AssistantStreamEvent }
  | { type: "message_end"; message: LlmMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage };

export type AgentContext = {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: AgentTool[];
};

export type BeforeToolCall = (ctx: {
  toolCall: { id: string; name: string; args: unknown };
}) => Promise<{ block?: boolean; reason?: string } | undefined>;

export type AfterToolCall = (ctx: {
  toolCall: { id: string; name: string; args: unknown };
  result: ToolResult;
  isError: boolean;
}) => Promise<Partial<ToolResult> & { isError?: boolean } | undefined>;

export type AgentLoopConfig = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
};

export async function* runAgentLoop(
  prompts: LlmMessage[],
  context: AgentContext,
  config: AgentLoopConfig = {},
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, LlmMessage[]> {
  const newMessages: LlmMessage[] = [...prompts];
  context.messages.push(...prompts);

  yield { type: "agent_start" };
  yield { type: "turn_start" };
  for (const p of prompts) {
    yield { type: "message_start", message: p };
    yield { type: "message_end", message: p };
  }

  let firstTurn = true;

  while (true) {
    if (!firstTurn) yield { type: "turn_start" };
    firstTurn = false;

    const assistant = yield* streamAssistant(context, signal);
    context.messages.push(assistant);
    newMessages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length === 0) {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      break;
    }

    const toolResults: ToolResultMessage[] = [];
    let terminateAll = true;

    for (const tc of toolCalls) {
      yield { type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments };

      const tool = context.tools.find((t) => t.name === tc.name);
      let result: ToolResult;
      let isError = false;

      if (!tool) {
        result = { content: [{ type: "text", text: `Tool ${tc.name} not found` }] };
        isError = true;
      } else {
        const before = await config.beforeToolCall?.({
          toolCall: { id: tc.id, name: tc.name, args: tc.arguments },
        });
        if (before?.block) {
          result = { content: [{ type: "text", text: before.reason ?? "Tool blocked" }] };
          isError = true;
        } else {
          try {
            result = await tool.execute(tc.arguments, signal);
          } catch (err) {
            result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
            isError = true;
          }
          const after = await config.afterToolCall?.({
            toolCall: { id: tc.id, name: tc.name, args: tc.arguments },
            result,
            isError,
          });
          if (after) {
            result = {
              content: after.content ?? result.content,
              details: after.details ?? result.details,
              terminate: after.terminate ?? result.terminate,
            };
            if (after.isError !== undefined) isError = after.isError;
          }
        }
      }

      if (!result.terminate) terminateAll = false;

      const trMessage: ToolResultMessage = {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError,
      };

      yield { type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: trMessage };
      yield { type: "message_start", message: trMessage };
      yield { type: "message_end", message: trMessage };

      context.messages.push(trMessage);
      newMessages.push(trMessage);
      toolResults.push(trMessage);
    }

    yield { type: "turn_end", message: assistant, toolResults };

    if (terminateAll) break; // every result asked to stop
  }

  yield { type: "agent_end", messages: newMessages };
  return newMessages;
}

async function* streamAssistant(
  context: AgentContext,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, AssistantMessage> {
  const tools = context.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const stream = streamAnthropic(context.systemPrompt, context.messages, tools, signal);
  let started = false;
  let finalMessage: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === "start") {
      started = true;
      yield { type: "message_start", message: event.partial };
    } else if (event.type === "done" || event.type === "error") {
      finalMessage = event.partial;
    } else {
      yield { type: "message_update", message: event.partial, assistantEvent: event };
    }
  }

  if (!finalMessage) throw new Error("No final message");
  if (!started) yield { type: "message_start", message: finalMessage };
  yield { type: "message_end", message: finalMessage };
  return finalMessage;
}
```

Try it:

```ts
// src/main.ts
import { runAgentLoop } from "./agent-loop.js";
import { addTool, getTimeTool } from "./tools.js";

const stream = runAgentLoop(
  [{ role: "user", content: [{ type: "text", text: "What is 2+3? Then tell me the time." }] }],
  {
    systemPrompt: "Use the tools precisely. Be concise.",
    messages: [],
    tools: [addTool, getTimeTool],
  },
);

for await (const event of stream) {
  if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
    process.stdout.write(event.assistantEvent.delta);
  } else if (event.type === "tool_execution_start") {
    console.log(`\n[tool] ${event.toolName}(${JSON.stringify(event.args)})`);
  } else if (event.type === "tool_execution_end") {
    const text = event.result.content.map((c) => c.text).join("");
    console.log(`[tool] -> ${text}`);
  } else if (event.type === "agent_end") {
    console.log("\n[agent_end]");
  }
}
```

You should see the model call `add`, get `5`, call `get_time`, and write a
final answer.

---

## Phase 5 — `terminate` and what it really means

We already have `terminate` plumbed through. The pi-mono rule: **the loop
stops early only when every tool result in the batch sets
`terminate: true`**. Mixed batches keep going.

Quick test: a `notify_done` tool that always terminates.

```ts
export const notifyDoneTool: AgentTool = {
  name: "notify_done",
  description: "Signal that the agent has completed its task.",
  input_schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  execute: async (args) => {
    const { message } = args as { message: string };
    return {
      content: [{ type: "text", text: `Done: ${message}` }],
      terminate: true,
    };
  },
};
```

Add it to your tools list and steer the model toward calling it. Notice
that the loop ends without giving the model a final speaking turn.

Pi-mono uses this to cut a turn when the agent has nothing useful to add
after a "done" signal — e.g. confirming a destructive action.

---

## Phase 6 — Stateful `Agent` class

Up to here we have a one-shot generator. pi-mono's `Agent` keeps state
across calls, broadcasts events to subscribers, and exposes `prompt`,
`continue`, `abort`, and `waitForIdle`.

`src/agent.ts`:

```ts
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig } from "./agent-loop.js";
import type { AgentTool } from "./tools.js";
import type { LlmMessage } from "./types.js";

export type AgentSubscriber = (event: AgentEvent) => void | Promise<void>;

export type AgentOptions = {
  systemPrompt: string;
  tools?: AgentTool[];
  loopConfig?: AgentLoopConfig;
};

export class Agent {
  systemPrompt: string;
  tools: AgentTool[];
  messages: LlmMessage[] = [];
  isStreaming = false;

  private subscribers = new Set<AgentSubscriber>();
  private loopConfig: AgentLoopConfig;
  private activeAbort?: AbortController;
  private activeRun?: Promise<void>;

  constructor(opts: AgentOptions) {
    this.systemPrompt = opts.systemPrompt;
    this.tools = opts.tools ?? [];
    this.loopConfig = opts.loopConfig ?? {};
  }

  subscribe(fn: AgentSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  abort(): void {
    this.activeAbort?.abort();
  }

  waitForIdle(): Promise<void> {
    return this.activeRun ?? Promise.resolve();
  }

  async prompt(text: string): Promise<void> {
    if (this.isStreaming) throw new Error("Already streaming");
    const userMessage: LlmMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    await this.run([userMessage]);
  }

  async continue(): Promise<void> {
    if (this.isStreaming) throw new Error("Already streaming");
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role === "assistant") {
      throw new Error("Cannot continue from this state");
    }
    await this.run([]);
  }

  private async run(prompts: LlmMessage[]): Promise<void> {
    this.isStreaming = true;
    this.activeAbort = new AbortController();

    let resolve!: () => void;
    this.activeRun = new Promise<void>((r) => (resolve = r));

    try {
      const context: AgentContext = {
        systemPrompt: this.systemPrompt,
        messages: this.messages,   // shared — agent loop mutates this list
        tools: this.tools,
      };

      const stream = runAgentLoop(prompts, context, this.loopConfig, this.activeAbort.signal);

      for await (const event of stream) {
        for (const fn of this.subscribers) {
          await fn(event);
        }
      }
    } finally {
      this.isStreaming = false;
      this.activeAbort = undefined;
      resolve();
      this.activeRun = undefined;
    }
  }
}
```

`main.ts` becomes friendlier:

```ts
import { Agent } from "./agent.js";
import { addTool, getTimeTool } from "./tools.js";

const agent = new Agent({
  systemPrompt: "Be concise. Use tools when useful.",
  tools: [addTool, getTimeTool],
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
    process.stdout.write(event.assistantEvent.delta);
  }
  if (event.type === "tool_execution_end") {
    const text = event.result.content.map((c) => c.text).join("");
    process.stdout.write(`\n[tool ${event.toolName} -> ${text}]\n`);
  }
});

await agent.prompt("Add 2 and 3, then tell me the time.");
console.log("\n[done]");
```

You can call `agent.prompt(...)` again afterwards — the transcript
persists.

---

## Phase 7 — Steering and follow-up queues

Two queues let you push messages while the agent is running.

- **Steering**: drained between turns — used to interrupt the agent.
- **Follow-up**: drained after the agent would otherwise stop.

Add them to `agent-loop.ts`:

```ts
export type AgentLoopConfig = {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
  getSteeringMessages?: () => Promise<LlmMessage[]>;
  getFollowUpMessages?: () => Promise<LlmMessage[]>;
};
```

Replace the loop body with two nested loops: an inner loop that injects
steering messages between turns and runs the assistant + tools; an outer
loop that polls `getFollowUpMessages` and re-enters the inner loop:

```ts
let firstTurn = true;
let pending: LlmMessage[] = (await config.getSteeringMessages?.()) ?? [];

while (true) {
  let hasMoreTools = true;

  while (hasMoreTools || pending.length > 0) {
    if (!firstTurn) yield { type: "turn_start" };
    firstTurn = false;

    for (const msg of pending) {
      yield { type: "message_start", message: msg };
      yield { type: "message_end", message: msg };
      context.messages.push(msg);
      newMessages.push(msg);
    }
    pending = [];

    const assistant = yield* streamAssistant(context, signal);
    context.messages.push(assistant);
    newMessages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      yield { type: "turn_end", message: assistant, toolResults: [] };
      yield { type: "agent_end", messages: newMessages };
      return newMessages;
    }

    const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
    let toolResults: ToolResultMessage[] = [];
    hasMoreTools = false;

    if (toolCalls.length > 0) {
      const exec = yield* executeTools(toolCalls, context, config, signal);
      toolResults = exec.results;
      hasMoreTools = !exec.terminate;
      for (const r of toolResults) {
        context.messages.push(r);
        newMessages.push(r);
      }
    }

    yield { type: "turn_end", message: assistant, toolResults };

    pending = (await config.getSteeringMessages?.()) ?? [];
  }

  const followUps = (await config.getFollowUpMessages?.()) ?? [];
  if (followUps.length > 0) {
    pending = followUps;
    continue;
  }
  break;
}

yield { type: "agent_end", messages: newMessages };
return newMessages;
```

Move tool execution into a helper `executeTools` for clarity. It
generates the tool events and returns
`{ results: ToolResultMessage[]; terminate: boolean }`.

Then expose queues on `Agent`:

```ts
private steerQueue: LlmMessage[] = [];
private followUpQueue: LlmMessage[] = [];

steer(text: string) {
  this.steerQueue.push({ role: "user", content: [{ type: "text", text }] });
}

followUp(text: string) {
  this.followUpQueue.push({ role: "user", content: [{ type: "text", text }] });
}

// inside run() — pass these through loopConfig
const cfg: AgentLoopConfig = {
  ...this.loopConfig,
  getSteeringMessages: async () => this.steerQueue.splice(0, 1), // one-at-a-time
  getFollowUpMessages: async () => this.followUpQueue.splice(0, 1),
};
```

Try it: subscribe to `tool_execution_start`, and after the first tool
fires, call `agent.steer("Stop and summarize what you've done.")` from
inside the listener. The next turn will receive the steer message and the
assistant will respond accordingly.

---

## Phase 8 — `AgentMessage`, `convertToLlm`, custom messages

So far our messages come straight from the LLM vocabulary. pi-mono lets
hosts add custom messages (notifications, system events, UI artifacts).
Those messages live in `agent.messages` for UI rendering but must be
filtered or rewritten before each LLM call.

Add a custom type to `types.ts`:

```ts
export type NotificationMessage = {
  role: "notification";
  text: string;
};

export type AgentMessage = LlmMessage | NotificationMessage;
```

Replace `AgentContext.messages` with `AgentMessage[]`. Add a
`convertToLlm` step before each provider call:

```ts
export type AgentLoopConfig = {
  // ...
  convertToLlm?: (messages: AgentMessage[]) => LlmMessage[] | Promise<LlmMessage[]>;
};

const defaultConvert = (messages: AgentMessage[]): LlmMessage[] =>
  messages.filter(
    (m): m is LlmMessage => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );

// inside streamAssistant, just before calling streamAnthropic:
const convert = config.convertToLlm ?? defaultConvert;
const llmMessages = await convert(context.messages);
const stream = streamAnthropic(context.systemPrompt, llmMessages, tools, signal);
```

Now you can do this on the `Agent`:

```ts
agent.messages.push({ role: "notification", text: "User upgraded plan" });
await agent.prompt("Continue."); // notification is in transcript but the LLM never sees it
```

If you instead want the LLM to see notifications as user context, supply
your own `convertToLlm` that maps them to user messages:

```ts
new Agent({
  ...,
  loopConfig: {
    convertToLlm: (messages) =>
      messages.flatMap((m) =>
        m.role === "notification"
          ? [{ role: "user" as const, content: [{ type: "text", text: `[note] ${m.text}` }] }]
          : [m],
      ),
  },
});
```

This is the same boundary as
`packages/agent/src/agent-loop.ts:240` (`streamAssistantResponse`) in
pi-mono.

---

## Phase 9 — (optional) Parallel tool execution

In Phase 4 we ran tools sequentially. pi-mono's default is parallel:
preflight (validation + `beforeToolCall`) is sequential, then allowed
tools execute concurrently. Tool-result messages are emitted in
**assistant source order** so the transcript is deterministic.

Sketch:

```ts
async function* executeToolsParallel(toolCalls, context, config, signal) {
  // 1. Sequential preflight: validate + beforeToolCall.
  //    Build an array of either { kind: "immediate", result } or
  //    { kind: "prepared", run: () => Promise<Finalized> }
  const prepared = [];
  for (const tc of toolCalls) {
    yield { type: "tool_execution_start", ... };
    prepared.push(await prepare(tc));
  }

  // 2. Parallel execute.
  const finalized = await Promise.all(
    prepared.map((p) => (p.kind === "immediate" ? p : p.run())),
  );

  // 3. Emit tool_execution_end + toolResult messages in source order.
  for (const f of finalized) {
    yield { type: "tool_execution_end", ... };
    yield { type: "message_start", message: f.toolResultMessage };
    yield { type: "message_end", message: f.toolResultMessage };
  }
}
```

Add a `executionMode` field on `AgentTool` and a `toolExecution` field on
`AgentLoopConfig`. If any tool in the batch sets
`executionMode: "sequential"`, fall back to the sequential path.

This is exactly what `executeToolCalls` does in
`packages/agent/src/agent-loop.ts:338`.

---

## Phase 10 — What you have now

You've reproduced pi-mono's core orchestration in roughly 400 lines:

- A normalized provider event stream (`text_delta`, `toolcall_*`, `done`,
  `error`).
- An agent loop that emits `turn_*`, `message_*`, `tool_execution_*` and
  drives multi-turn tool dialogues.
- `beforeToolCall` / `afterToolCall` hooks and `terminate` semantics.
- A stateful `Agent` class with `subscribe`, `prompt`, `continue`,
  `abort`, `waitForIdle`, plus steering and follow-up queues.
- A `convertToLlm` boundary supporting custom message types.

What pi-mono does on top:

| Feature | Where in pi-mono | What you'd add |
| --- | --- | --- |
| Multi-provider | `packages/ai/src/api-registry.ts` | A registry mapping `model.api` → provider stream functions |
| Parallel + per-tool execution mode | `agent-loop.ts:412` | The Phase 9 sketch |
| `transformContext` hook | `agent-loop.ts:248` | Run before `convertToLlm` for pruning / external context |
| Retries with backoff | `agent-session.ts` `_retryPromise` | Wrap the run in a retry orchestrator |
| Persistence | `session-manager.ts` | Append each `message_end` to a JSONL log |
| Extensions, slash commands, skills | `extensions/`, `slash-commands.ts` | Pre-process prompt text before `agent.prompt()` |
| Auto-compaction | `compaction/` | A `transformContext` that summarises old turns |
| Thinking content + adaptive reasoning | `providers/anthropic.ts` | Emit `thinking_*` events and pass thinking budgets |

A natural next step is to extract everything that mentions Anthropic into
a `providers/` folder, define a registry, and add a second provider
(OpenAI's Chat Completions is a 100-line variant). Once you have that,
you've matched pi-mono's bone structure.

## Suggested verification along the way

After each phase, run a small smoke test:

| Phase | Test |
| --- | --- |
| 1 | Streamed greeting prints character by character. |
| 2 | Same output, but routed through `text_delta` events. |
| 3 | `agent_start` → `turn_start` → `agent_end` framing visible in logs. |
| 4 | Model calls `add(2,3)` and reads back `5`. |
| 5 | A `notify_done` tool causes the loop to exit with no extra turn. |
| 6 | `agent.prompt(...)` twice in a row, second prompt sees prior context. |
| 7 | Subscriber calls `agent.steer(...)` mid-run; next turn shows the steer message. |
| 8 | `notification` messages persist in `agent.messages` but never reach the LLM. |
| 9 | Two slow tools complete in `max(t1, t2)` seconds, not `t1 + t2`. |

If a phase misbehaves, log the agent event stream — every interesting
state transition has a named event, just like pi-mono.
