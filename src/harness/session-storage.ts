import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../types.js";

export interface SessionMetadata {
  id: string;
  createdAt: string;
}

interface BaseEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: AgentMessage;
}


export interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  provider: string;
  modelId: string;
}


export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type SessionTreeEntry = MessageEntry | ModelChangeEntry | CompactionEntry;



export interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
}



export class InMemorySessionStorage implements SessionStorage {
private metadata: SessionMetadata;
  private entries: SessionTreeEntry[] = [];
  private byId = new Map<string, SessionTreeEntry>();
  private leafId: string | null = null;

   constructor() {
    this.metadata = { id: randomUUID(), createdAt: new Date().toISOString() };
  }

  async getMetadata() { return this.metadata; }
  async getLeafId() { return this.leafId; }
  async setLeafId(leafId: string | null) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error(`Entry ${leafId} not found`);
    this.leafId = leafId;
  }
 async createEntryId() {
    for (let i = 0; i < 100; i++) {
      const id = randomUUID().slice(0, 8);
      if (!this.byId.has(id)) return id;
    }
    return randomUUID();
  }
  async appendEntry(entry: SessionTreeEntry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }
  async getEntry(id: string) { return this.byId.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path;
  }
  async getEntries() { return [...this.entries]; }
}
