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
