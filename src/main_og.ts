import { runAgentLoop } from "./agent-loop.js";
import { addTool, getTimeTool, notifyDoneTool } from './tools.js';
//TODO: see if grep hits
const stream = runAgentLoop(
  [{ role: "user", content: [{ type: "text", text: "What is 2+3? Then tell me the time. When finished, call notify_done with message 'answered math and time'. Do not give a final text response." }] }],
  {
    systemPrompt: "Use the tools precisely. Be concise. When the task is complete, call notify_done instead of writing a final assistant message.",
    messages: [],
    tools: [addTool, getTimeTool, notifyDoneTool],
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

/**
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
*/


