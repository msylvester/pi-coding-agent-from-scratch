/*
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
*/



import { Agent } from "./agent.js";
import { buildSystemPrompt }  from './system-prompt.js';
import { createBashTool } from "./coding-tools/bash.js";
import { createEditTool } from "./coding-tools/edit.js";
import { createFindTool } from "./coding-tools/find.js";
import { createGrepTool } from "./coding-tools/grep.js";
import { createReadTool } from "./coding-tools/read.js";
import { createWriteTool } from "./coding-tools/write.js";
import { ProcessTerminal } from "./terminal.js";
import { ChatLog } from "./chat-log.js";

async function runPrompt(prompt: string) : Promise<void>  {
    const cwd= process.cwd();
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
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: {
      read: "Read file contents",
      bash: "Execute bash commands",
      edit: "Make precise file edits with exact text replacement",
      write: "Create or overwrite files",
    },
  });
  

  const agent = new Agent({
    systemPrompt,
    tools,
  });

  const term = new ProcessTerminal();
  term.hideCursor();
  new ChatLog(term, agent);
  process.on("exit", () => {
    term.showCursor();
    term.write("\n");
  });

  let steered = false;
/**  
* agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
      process.stdout.write(event.assistantEvent.delta);
    }
    if (event.type === "agent_start") {
      process.stdout.write("\n---- agent start ----\n");
    }

    if (event.type === "tool_execution_start") {
      process.stdout.write(`\n[tool_execution_start: ${event.toolName}]\n`);
      if (!steered) {
        steered = true;
        agent.steer("Stop and summarize what you've done.");
        process.stdout.write(`[steered]\n`);
      }
    }
    if (event.type === "tool_execution_end") {
      const text = event.result.content.map((c) => c.text).join("");
      process.stdout.write(`\n[tool ${event.toolName} -> ${text}]\n`);
    }
    if (event.type === "message_start" && event.message.role === "notification") {
      process.stdout.write(`\n[notify: ${event.message.text}]\n`);
    }
    if (event.type === "turn_start") process.stdout.write(`\n--- turn_start ---\n`);
    if (event.type === "turn_end") {
      process.stdout.write(`\n--- turn_end (stop=${event.message.stopReason}) ---\n`);
      if (event.message.errorMessage) {
        process.stdout.write(`[error: ${event.message.errorMessage}]\n`);
      }
    }
  });
*/

//  agent.notify("Session started at " + new Date().toISOString());
    await agent.prompt(prompt);
}

function resolveUserPrompt(): string {
   const fromNpm = process.env.npm_config_prompt;
   if (fromNpm && fromNpm !== "true") return fromNpm;

   const argv = process.argv.slice(2);
   const i = argv.indexOf("--prompt");
   if (i !== -1 && argv[i + 1]) return argv[i + 1];

   const eq = argv.find((a) => a.startsWith("--prompt="));
   if (eq) return eq.slice("--prompt=".length);

   console.error('Usage: npm run dev --prompt "your system prompt"');
   process.exit(1);
 }

const systemPrompt = resolveUserPrompt();

await runPrompt(systemPrompt);



