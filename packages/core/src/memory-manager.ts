export type MemoryKind =
  | "build_command"
  | "test_command"
  | "style_preference"
  | "repo_fact"
  | "known_flaky_test"
  | "recurring_mistake"
  | "herta_lesson";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "build_command",
  "test_command",
  "style_preference",
  "repo_fact",
  "known_flaky_test",
  "recurring_mistake",
  "herta_lesson",
] as const;

export interface MemoryItem {
  id: string;
  scope: "repo" | "user";
  kind: MemoryKind;
  text: string;
  /** Why it holds — what the user said or what happened (ADR 0077). Items
   *  saved before have none. */
  why?: string;
  sourceSession: string;
  createdAt: string;
  /** When it was last saved: a save of the same fact re-confirms it, and
   *  recall shows the age from here (ADR 0077). */
  lastSeen: string;
  confidence: number;
}

export interface MemoryQuery {
  scope?: "repo" | "user";
  kind?: MemoryKind;
}

export interface MemoryManager {
  recall(query: MemoryQuery): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  /**
   * Synchronous read of the current in-memory snapshot. Returns the empty
   * array if the manager hasn't loaded yet (e.g., before the first recall()
   * or save() has populated the cache). Implementations must NOT perform
   * disk I/O here — this is the path called by the capsule pipeline on
   * every turn.
   */
  currentItems(): readonly MemoryItem[];
}

export class NoopMemoryManager implements MemoryManager {
  async recall(_query: MemoryQuery): Promise<MemoryItem[]> {
    return [];
  }
  async save(_item: MemoryItem): Promise<void> {
    // no-op
  }
  currentItems(): readonly MemoryItem[] {
    return [];
  }
}
