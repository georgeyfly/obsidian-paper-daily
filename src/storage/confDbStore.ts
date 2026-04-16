import type { ConfDbMap, ConfDbRecord } from "../types/paper";
import type { VaultWriter } from "./vaultWriter";

export function normalizeConfId(id: string): string {
  return id.replace(/^arxiv:/i, "").replace(/v\d+$/i, "").toLowerCase().trim();
}

export class ConfDbStore {
  private map: ConfDbMap = {};
  private readonly path: string;

  constructor(private writer: VaultWriter, rootFolder: string) {
    this.path = `${rootFolder}/cache/conf_db.json`;
  }

  async load(): Promise<void> {
    const content = await this.writer.readNote(this.path);
    if (content) {
      try {
        const parsed = JSON.parse(content) as ConfDbMap;
        this.map = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        this.map = {};
      }
    }
  }

  async save(): Promise<void> {
    await this.writer.writeNote(this.path, JSON.stringify(this.map, null, 2));
  }

  has(id: string): boolean {
    return normalizeConfId(id) in this.map;
  }

  get(id: string): ConfDbRecord | undefined {
    return this.map[normalizeConfId(id)];
  }

  upsert(record: ConfDbRecord): void {
    const key = normalizeConfId(record.id);
    const existing = this.map[key];
    if (existing) {
      this.map[key] = {
        ...existing,
        ...record,
        id: key,
        sharedDates: existing.sharedDates,
        firstSeenAt: existing.firstSeenAt,
      };
    } else {
      this.map[key] = { ...record, id: key };
    }
  }

  markShared(id: string, date: string): void {
    const key = normalizeConfId(id);
    const rec = this.map[key];
    if (rec && !rec.sharedDates.includes(date)) {
      rec.sharedDates.push(date);
    }
  }

  getUnshared(): ConfDbRecord[] {
    return Object.values(this.map).filter(r => r.sharedDates.length === 0);
  }

  getAll(): ConfDbRecord[] {
    return Object.values(this.map);
  }

  size(): number {
    return Object.keys(this.map).length;
  }
}
