import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SessionMetadata,
  SessionStorage,
  SessionTreeEntry,
} from "./session-storage.js";

interface JsonlHeader {
  type: "session_header";
  id: string;
  createdAt: string;
  cwd: string;
}

export class JsonlSessionStorage implements SessionStorage {
  private metadata!: SessionMetadata;
  private entries: SessionTreeEntry[] = [];
  private byId = new Map<string, SessionTreeEntry>();
  private leafId: string | null = null;
  private leafFile: string;

  constructor(private path: string) {
    this.leafFile = `${path}.leaf`;
  }

  async open(cwd: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let content: string | null = null;
    try {
      content = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (content !== null) {
      const lines = content.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]) as JsonlHeader;
      this.metadata = { id: header.id, createdAt: header.createdAt };
      for (const line of lines.slice(1)) {
        const entry = JSON.parse(line) as SessionTreeEntry;
        this.entries.push(entry);
        this.byId.set(entry.id, entry);
      }
      try {
        const raw = (await readFile(this.leafFile, "utf8")).trim();
        this.leafId = raw || null;
      } catch {
        this.leafId = this.entries[this.entries.length - 1]?.id ?? null;
      }
      return;
    }
    this.metadata = { id: randomUUID(), createdAt: new Date().toISOString() };
    const header: JsonlHeader = { type: "session_header", ...this.metadata, cwd };
    await writeFile(this.path, `${JSON.stringify(header)}\n`);
  }

  async getMetadata() { return this.metadata; }
  async getLeafId() { return this.leafId; }
  async setLeafId(leafId: string | null) {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new Error(`Entry ${leafId} not found`);
    }
    this.leafId = leafId;
    await writeFile(this.leafFile, leafId ?? "");
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
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    this.leafId = entry.id;
    await writeFile(this.leafFile, entry.id);
  }
  async getEntry(id: string) { return this.byId.get(id); }
  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let cur = this.byId.get(leafId);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return path;
  }
  async getEntries() { return [...this.entries]; }
}
