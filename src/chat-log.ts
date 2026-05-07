import type { Agent } from "./agent.js";
import type { Terminal } from "./terminal.js";

export class ChatLog {
  private streamingAssistant = false;
  private assistantNeedsIndent = true;

  constructor(
    private term: Terminal,
    agent: Agent,
  ) {
    agent.subscribe((event) => this.onEvent(event));
  }

  private onEvent(event: Parameters<Parameters<Agent["subscribe"]>[0]>[0]): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.streamingAssistant = true;
          this.assistantNeedsIndent = true;
        }
        break;

      case "message_update":
        if (this.streamingAssistant && event.assistantEvent.type === "text_delta") {
          this.writeAssistantDelta(event.assistantEvent.delta);
        }
        break;

      case "message_end":
        if (this.streamingAssistant) {
          this.term.write("\n");
          this.streamingAssistant = false;
        }
        break;

      case "tool_execution_start": {
        const args = truncate(JSON.stringify(event.args), this.term.columns - 6);
        this.term.write(`${dim("·")} ${event.toolName}(${args})\n`);
        break;
      }

      case "tool_execution_end": {
        const text = event.result.content.map((c) => c.text).join("");
        const lines = text.split("\n");
        const first = lines.slice(0, 5).join("\n");
        const remaining = lines.length - 5;
        const prefix = event.result.isError ? red("✗") : dim("←");
        this.term.write(`${prefix} ${truncate(first, this.term.columns - 2)}\n`);
        if (remaining > 0) this.term.write(dim(`  (+${remaining} more lines)\n`));
        break;
      }
    }
  }

  private writeAssistantDelta(delta: string): void {
    const parts = delta.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        this.term.write("\n");
        this.assistantNeedsIndent = true;
      }
      const part = parts[i] ?? "";
      if (part.length === 0) continue;
      if (this.assistantNeedsIndent) {
        this.term.write("  ");
        this.assistantNeedsIndent = false;
      }
      this.term.write(part);
    }
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
