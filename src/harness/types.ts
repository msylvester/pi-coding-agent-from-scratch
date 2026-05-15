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
