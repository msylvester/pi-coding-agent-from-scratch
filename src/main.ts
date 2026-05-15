import { createInterface } from "node:readline/promises";
import { NodeExecutionEnv } from "./harness/env.js";
import { JsonlSessionStorage } from "./harness/jsonl-storage.js";
import { Session } from "./harness/session.js";
import { AgentHarness } from "./harness/agent-harness.js";
import {
  createBashTool, createEditTool, createFindTool,
  createGrepTool, createReadTool, createWriteTool,
} from "./coding-tools/index.js";
import { buildSystemPrompt } from "./system-prompt.js";

const argv = process.argv.slice(2);
let sessionPath: string | undefined;
const sIdx = argv.indexOf("--session");
if (sIdx >= 0) {
  sessionPath = argv[sIdx + 1];
  argv.splice(sIdx, 2);
}
sessionPath ??= `./.pi-sessions/${Date.now()}.jsonl`;

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const storage = new JsonlSessionStorage(sessionPath);
await storage.open(env.cwd);
const session = new Session(storage);

const tools = [
  createReadTool(env),
  createWriteTool(env),
  createEditTool(env),
  createBashTool(env),
  createGrepTool(env),
  createFindTool(env.cwd),
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
  if (event.type === "message_update" && event.assistantEvent.type === "text_delta") {
    process.stdout.write(event.assistantEvent.delta);
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.errorMessage) process.stderr.write(`\n[error] ${event.message.errorMessage}\n`);
    else process.stdout.write("\n");
  }
});

process.on("SIGINT", () => {
  harness.abort().catch(() => {});
});

const initial = argv.join(" ");
if (initial) await harness.prompt(initial);

const rl = createInterface({ input: process.stdin, output: process.stdout });
while (true) {
  const text = await rl.question("\n› ");
  if (!text.trim()) continue;
  if (text === "/quit" || text === "/exit") break;
  await harness.prompt(text);
}
rl.close();



/**
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
import { NodeExecutionEnv } from "./harness/env.js";

const cwd = process.cwd();
const env = new NodeExecutionEnv({ cwd });
const tools = [
  createReadTool(env),
  createWriteTool(env),
  createEditTool(env),
  createBashTool(env),
  createGrepTool(env),
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

*/
