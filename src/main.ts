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
