import type { TerminalRecord } from "@herta/app-server";
import { useMemo, useSyncExternalStore } from "react";
import type { AttachProgressEvent } from "../../ipc/bridge-types.js";
import {
  ATTACH_PROGRESS_DEFAULTS,
  type AttachProgress,
  type AttachProgressFrame,
  createAttachProgress,
} from "./attach-progress.js";
import type { SystemBlock } from "./group-record.js";

/**
 * The attach in flight, as rows (2026-10-01, owner's pick "Hairline").
 *
 * Attaching waits while main reads — for a PDF, its pages and then its
 * pictures' transcripts, seconds and sometimes tens of them — and the record
 * gains the attachment blocks only at the end. Meanwhile the conversation
 * shows PLACEHOLDER rows: attachment-shaped blocks appended after the record's
 * last block, i.e. exactly where the real blocks will land. Grouping keys an
 * activity group by its first block's absolute index, so the placeholder
 * group IS the real group's slot: when the real blocks arrive the group keeps
 * its key, its entrance has already played, and each row turns into its final
 * text in place while its hairline fades and folds away.
 *
 * Placeholders never reach the store, the record, the bridge or the disk —
 * they exist only between grouping and rendering (D7: same record, different
 * overlay). Their progress travels outside React's row memos: the hairline
 * and the count subscribe here, frame by frame, and nothing above them
 * re-renders.
 */

interface Pending {
  readonly id: number;
  readonly sessionId: string;
  /** The record's absolute length when the attach began — where the real
   *  blocks will land. */
  readonly baseAbs: number;
  readonly startedAt: number;
  readonly blocks: readonly SystemBlock[];
  readonly models: readonly AttachProgress[];
  /** The row is on screen (the read outlasted `showAfterMs`). A change
   *  REPLACES the object — it is the hook's snapshot. */
  readonly shown: boolean;
}

/** How long a finished hairline stays marked for its fade (ms). */
const HANDOFF_MS = 700;
/** How long an answered attach waits for its record blocks before its
 *  placeholders go anyway (ms) — they arrive on a different channel. */
const AWAIT_RECORD_MS = 1500;

let nextId = 1;
let pending: Pending | null = null;
let frames: readonly (AttachProgressFrame | undefined)[] = [];
const indexOf = new WeakMap<SystemBlock, number>();
const finishing = new WeakSet<object>();
/** Attaches whose real blocks have taken the placeholders' place. */
const handedOff = new Set<number>();
const structural = new Set<() => void>();
const perFrame = new Set<() => void>();
let raf: number | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

const now = (): number => performance.now();
const requestFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

function notify(set: Set<() => void>): void {
  for (const l of [...set]) l();
}

function sameFrame(
  a: AttachProgressFrame | undefined,
  b: AttachProgressFrame,
): boolean {
  return (
    a !== undefined &&
    a.stage === b.stage &&
    a.done === b.done &&
    a.total === b.total &&
    Math.abs(a.fraction - b.fraction) < 0.0005
  );
}

function tick(): void {
  raf = null;
  const p = pending;
  if (p === null) return;
  const t = now();
  let changed = false;
  const next = p.models.map((m, i) => {
    const f = m.frame(t);
    const prev = frames[i];
    if (sameFrame(prev, f)) return prev;
    changed = true;
    return f;
  });
  if (changed) {
    frames = next;
    notify(perFrame);
  }
  raf = requestFrame(tick);
}

function clear(id: number): void {
  if (pending === null || pending.id !== id) return;
  handedOff.delete(id);
  pending = null;
  frames = [];
  if (raf !== null) cancelFrame(raf);
  raf = null;
  if (showTimer !== null) clearTimeout(showTimer);
  showTimer = null;
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = null;
  notify(structural);
  notify(perFrame);
}

/** The composer began an attach. Returns its id for `endPendingAttach`. A
 *  previous attach still pending is replaced (the composer refuses a second
 *  drop while one reads, so this is only ever a stale one). */
export function startPendingAttach(opts: {
  readonly sessionId: string;
  readonly names: readonly string[];
  readonly baseAbs: number;
}): number {
  if (pending !== null) clear(pending.id);
  const id = nextId++;
  const at = new Date().toISOString();
  const blocks = opts.names.map((name, i) => {
    const block = {
      kind: "system",
      label: "系统",
      body: name,
      at,
      digest: { kind: "attachment", name, path: "", lines: 0, chars: 0 },
    } as SystemBlock;
    indexOf.set(block, i);
    return block;
  });
  const startedAt = now();
  pending = {
    id,
    sessionId: opts.sessionId,
    baseAbs: opts.baseAbs,
    startedAt,
    blocks,
    models: blocks.map(() => createAttachProgress(startedAt)),
    shown: false,
  };
  frames = [];
  showTimer = setTimeout(() => {
    showTimer = null;
    if (pending?.id !== id) return;
    pending = { ...pending, shown: true };
    notify(structural);
  }, ATTACH_PROGRESS_DEFAULTS.showAfterMs);
  raf = requestFrame(tick);
  return id;
}

/** One file's progress from main. Ignored unless it is the attach in flight. */
export function reportAttachProgress(e: AttachProgressEvent): void {
  const p = pending;
  if (p === null || p.sessionId !== e.sessionId) return;
  p.models[e.index]?.report(
    { stage: e.stage, done: e.done, total: e.total },
    now(),
  );
}

/** The attach answered. A refusal or failure takes the rows down at once; a
 *  success leaves them for the record blocks to replace — or, when no row
 *  was ever shown, simply ends (the real group arrives with its entrance). */
export function endPendingAttach(id: number, ok: boolean): void {
  const p = pending;
  if (p === null || p.id !== id) return;
  for (const m of p.models)
    m.report({ stage: "done", done: 0, total: 0 }, now());
  if (!ok || !p.shown || handedOff.has(id)) {
    clear(id);
    return;
  }
  clearTimer = setTimeout(() => clear(id), AWAIT_RECORD_MS);
}

/** The file index a placeholder block stands for, or undefined for a real
 *  block. */
export function pendingAttachIndex(block: SystemBlock): number | undefined {
  return indexOf.get(block);
}

/** Whether a REAL block just replaced a placeholder — its row plays the
 *  hairline's fade instead of losing it at once. */
export function isAttachHandoff(block: SystemBlock): boolean {
  return finishing.has(block);
}

function subscribeStructural(l: () => void): () => void {
  structural.add(l);
  return () => {
    structural.delete(l);
  };
}

function subscribeFrames(l: () => void): () => void {
  perFrame.add(l);
  return () => {
    perFrame.delete(l);
  };
}

/**
 * The record the conversation renders: the real one, plus the placeholder
 * blocks while an attach of THIS session is in flight and on screen. The
 * moment the record grows past where the attach began, the real blocks are
 * there: the placeholders give way in the same render, and those blocks are
 * marked to fade their hairline.
 */
export function usePendingAttachRecord(
  sessionId: string | null,
  record: TerminalRecord,
  recordStart: number,
): TerminalRecord {
  const p = useSyncExternalStore(subscribeStructural, () => pending);
  return useMemo(() => {
    if (p === null || !p.shown || p.sessionId !== sessionId) return record;
    const abs = recordStart + record.length;
    if (handedOff.has(p.id)) return record;
    if (abs === p.baseAbs) return [...record, ...p.blocks];
    if (abs > p.baseAbs) {
      // The real blocks landed where the placeholders stood. Mark them for
      // the fade (idempotent — a StrictMode re-run adds the same objects),
      // and end the attach outside this render once it has answered.
      for (const b of record.slice(Math.max(0, p.baseAbs - recordStart))) {
        if (b.kind === "system" && b.digest?.kind === "attachment") {
          finishing.add(b);
          setTimeout(() => finishing.delete(b), HANDOFF_MS);
        }
      }
      handedOff.add(p.id);
      const id = p.id;
      setTimeout(() => {
        if (pending?.id === id && clearTimer !== null) clear(id);
      }, 0);
    }
    return record;
  }, [p, sessionId, record, recordStart]);
}

/** One placeholder row's progress, frame by frame. */
export function useAttachFrame(index: number): AttachProgressFrame | undefined {
  return useSyncExternalStore(subscribeFrames, () => frames[index]);
}

/** Tests only: drop whatever is pending. */
export function resetPendingAttachForTest(): void {
  if (pending !== null) clear(pending.id);
}

/** Tests only: what is pending, by its facts. */
export function peekPendingAttachForTest(): {
  readonly sessionId: string;
  readonly names: readonly string[];
  readonly baseAbs: number;
  readonly shown: boolean;
} | null {
  if (pending === null) return null;
  return {
    sessionId: pending.sessionId,
    names: pending.blocks.map((b) =>
      b.digest?.kind === "attachment" ? b.digest.name : "",
    ),
    baseAbs: pending.baseAbs,
    shown: pending.shown,
  };
}
