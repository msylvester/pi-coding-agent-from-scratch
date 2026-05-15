import Anthropic from "@anthropic-ai/sdk";
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
      const text = (m as UserMessage).content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      lines.push(`USER: ${text}`);
    } else if (m.role === "assistant") {
      const a = m as AssistantMessage;
      for (const block of a.content) {
        if (block.type === "text") lines.push(`ASSISTANT: ${block.text}`);
        else if (block.type === "toolCall") {
          lines.push(`ASSISTANT [tool: ${block.name}] ${JSON.stringify(block.arguments).slice(0, 200)}`);
        }
      }
    } else if (m.role === "toolResult") {
      const text = (m as ToolResultMessage).content
        .map((c) => c.text)
        .join("")
        .slice(0, 2000);
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
