import type { AgentMessage } from "../types.js";
import type {
  CompactionEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionStorage,
  SessionTreeEntry,
} from "./session-storage.js";
import {
  COMPACTION_PREFIX,
  COMPACTION_SUFFIX,
  createCompactionSummaryMessage,
} from "./messages.js";

export interface SessionContext {
  messages: AgentMessage[];
  model: { provider: string; modelId: string } | null;
}

export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let model: { provider: string; modelId: string } | null = null;
  let compaction: CompactionEntry | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: AgentMessage[] = [];
  const appendIfMessage = (entry: SessionTreeEntry) => {
    if (entry.type === "message") messages.push(entry.message);
  };
  if (compaction) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: COMPACTION_PREFIX + compaction.summary + COMPACTION_SUFFIX }],
    });
    const compactionIdx = pathEntries.findIndex((e) => e === compaction);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      if (pathEntries[i].id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendIfMessage(pathEntries[i]);
    }
    for (let i = compactionIdx + 1; i < pathEntries.length; i++) appendIfMessage(pathEntries[i]);
  } else {
    for (const entry of pathEntries) appendIfMessage(entry);
  }

  return { messages, model };
}


export class Session {
  constructor(private storage: SessionStorage) {}

  getMetadata() { return this.storage.getMetadata(); }
  getLeafId() { return this.storage.getLeafId(); }
  getEntries() { return this.storage.getEntries(); }
  getEntry(id: string) { return this.storage.getEntry(id); }

  async getBranch(): Promise<SessionTreeEntry[]> {
    return this.storage.getPathToRoot(await this.storage.getLeafId());
  }

  async buildContext(): Promise<SessionContext> {
    return buildSessionContext(await this.getBranch());
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    const entry: MessageEntry = {
      type: "message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      message,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }

  async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<string> {
    const entry: CompactionEntry = {
      type: "compaction",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    await this.storage.appendEntry(entry);
    return entry.id;
  }
}


