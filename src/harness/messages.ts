import type { TextContent, ToolCallContent, ToolResultContent } from "../types.js";


export type { AgentMessage, AssistantMessage, UserMessage, ToolResultMessage } from "../types.js";


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
