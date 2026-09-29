// The outgoing send morph — one of the five state machines Conversation.tsx
// hosted; extracted on 2026-09-03 at the owner's request. On the pendingUser
// null→value edge a clone of the just-sent bubble flies from the composer to
// its resting slot in the flow (the flow bubble stays hidden until the landing
// hold ends), and the optimistic echo's own props — its pictures as bubble
// views, its send stamp — are derived here because the clone carries them.
// State: `outgoingClone`, `hidePendingUser`. Effects, in order: the detection
// LAYOUT effect (the edge) and the flight effect (keyed on the clone
// mounting) — the first two effects Conversation declares, as before.
// If the turn's real user block replaces the echo while the clone is still in
// the air (2026-09-30), the flight goes on onto the real row, hidden until
// the clone parks on it, with a guard timer so it can never stay hidden.

import type { TerminalRecord } from "@herta/app-server";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StagedImageInfo } from "../../ipc/bridge-types.js";
import {
  GLASS_MS,
  OUTGOING_FLIGHT_MS,
  SHADOW_SETTLE_MS,
} from "./conversation-timing.js";
import type { UserImageView } from "./UserBubble.js";
import {
  E_OUT_CUBIC,
  easeOutCubic,
  useRiseAnimation,
} from "./useRiseAnimation.js";

/** How long past the flight's own end (and its landing hold) a flight that
 *  continued onto the real row is landed by force, if the rise never says
 *  it has landed. */
const LANDING_GUARD_MARGIN_MS = 400;

export interface OutgoingClone {
  readonly text: string;
  readonly images: readonly UserImageView[];
  /** The hidden pending row's strip width, so the clone's strip wraps
   *  EXACTLY like the one it will swap for — a max-content clone laid
   *  three pictures in one oversized line while the landed row wrapped
   *  them into two (seen live 2026-08-27). */
  readonly imagesWidthPx?: number;
}

export function useOutgoingMorph(opts: {
  readonly pendingUser: string | null;
  readonly pendingUserImages: readonly StagedImageInfo[] | null;
  readonly reduced: boolean;
  readonly composerRef: RefObject<HTMLFormElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  /** The `.conversation-flow` column — the flight watches its WIDTH. */
  readonly flowRef: RefObject<HTMLDivElement>;
  /** The scroll engine's `isReadingHistory`, as a getter: the engine is
   *  created AFTER this hook (it takes the clone flag this hook owns), so
   *  the predicate is read at effect time — exactly what the inline effect
   *  did through the `scroll` const declared below it. */
  readonly isReadingHistory: () => boolean;
  /** The store's armed lift-off point, consumed on the send edge (ADR 0063:
   *  a held message flies from its card above the composer, not from the
   *  input). Absent or null: the composer's input, as ever. */
  readonly takeLaunch?: () => {
    readonly left: number;
    readonly top: number;
  } | null;
  /** The record window and where it starts — to recognise the turn's real
   *  user block landing mid-flight, and to find its row. */
  readonly record: TerminalRecord;
  readonly recordStart: number;
  readonly sessionId: string | null;
}) {
  const {
    pendingUser,
    pendingUserImages,
    reduced,
    composerRef,
    overlayRef,
    flowRef,
    isReadingHistory,
    takeLaunch,
    record,
    recordStart,
    sessionId,
  } = opts;
  /** The lift-off point this send armed, read by the flight effect. */
  const launchRef = useRef<{ left: number; top: number } | null>(null);

  // The optimistic echo's pictures as bubble views (ADR 0048 §4). No caption
  // yet — it is being computed main-side; the record row carries it. The
  // sniffed dimensions ride along so the echo reserves the real box before
  // the thumbnails load (the morph measures this slot).
  const pendingEchoImages = useMemo<readonly UserImageView[]>(
    () =>
      (pendingUserImages ?? []).map((s) => ({
        path: s.path,
        name: s.name,
        ...(s.width !== undefined ? { width: s.width } : {}),
        ...(s.height !== undefined ? { height: s.height } : {}),
      })),
    [pendingUserImages],
  );

  // Outgoing send morph: on the pendingUser null→value edge, mount a flying
  // clone in the workspace overlay and rise it from the composer to its
  // resting slot (crisp left/top). The flow bubble stays hidden until settle.
  const outgoingRise = useRiseAnimation();
  const cloneRef = useRef<HTMLDivElement>(null);
  const pendingUserBubbleRef = useRef<HTMLDivElement>(null);
  const [outgoingClone, setOutgoingClone] = useState<OutgoingClone | null>(
    null,
  );
  const [hidePendingUser, setHidePendingUser] = useState(false);
  const prevPendingUser = useRef<string | null>(null);
  /** Whether THIS send will actually fly a clone (set by the detection layout
   *  effect below, read by the send effect in the same commit). The sequenced
   *  travel is handed to the flight's settle, so a send with no flight has to
   *  keep travelling immediately or the reserved room never comes on screen. */
  const outgoingFlightArmedRef = useRef(false);
  /** The landing hold (SHADOW_SETTLE_MS): swap deferred while the parked
   *  clone's flight shadows fade. Cleared by every teardown path so a stale
   *  timer can't unhide a bubble a NEW flight just hid. */
  const outgoingSettleTimer = useRef<number | null>(null);
  /** When this flight took off, and the session it took off in. */
  const flightStartedAt = useRef(0);
  const flightSession = useRef<string | null>(null);
  /** The record as the previous commit saw it — to tell the turn's user block
   *  being APPENDED from a record replaced wholesale (a reset, a switch). */
  const prevRecord = useRef<TerminalRecord>(record);
  /** The real user row that landed mid-flight, hidden until the clone parks
   *  on it (owner 2026-09-30: a typed @板砖 skips the router, its user block
   *  lands within milliseconds, and the flight was cut at lift-off — the
   *  bubble "suddenly jumps to the target position"). */
  const landedRow = useRef<HTMLElement | null>(null);
  /** Lands the flight if the rise never reports it (a frozen or throttled
   *  timeline): the row must never stay hidden behind a stuck clone. */
  const landingGuard = useRef<number | null>(null);
  const clearLanding = (): void => {
    if (landingGuard.current !== null) {
      window.clearTimeout(landingGuard.current);
      landingGuard.current = null;
    }
    landedRow.current?.style.removeProperty("visibility");
    landedRow.current = null;
  };

  // Detection: on the pendingUser null→value edge, mount the flying clone +
  // hide the flow bubble. Geometry/animation happens in the effect below,
  // AFTER the clone has committed (so cloneRef is attached).
  // LAYOUT effect, deliberately: a passive useEffect runs after the browser
  // paints, so the flow bubble got one painted frame at its final position
  // before the hide flag landed — a visible flash, then the rise replayed
  // from the composer (seen live 2026-06-13). Setting the flag before paint
  // means the bubble is never painted until the morph settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the pendingUser null→value edge
  useLayoutEffect(() => {
    const appeared = prevPendingUser.current === null && pendingUser !== null;
    prevPendingUser.current = pendingUser;
    if (pendingUser === null) {
      // The echo gave way to the turn's REAL user block while the clone was
      // still in the air: the flight goes on, onto the real row. A typed
      // @板砖 does this within milliseconds (no router call heads its turn),
      // and a quick router could cut a plain send short the same way.
      // Appended, not replaced: the block before it is the previous commit's
      // last block — a reset or a switch lands a whole new record instead,
      // and those still end the flight.
      const last = record[record.length - 1];
      const prev = prevRecord.current;
      const appendedUser =
        last?.kind === "user" &&
        last.steer !== true &&
        (prev.length === 0
          ? record.length === 1
          : record[record.length - 2] === prev[prev.length - 1]);
      if (
        outgoingClone !== null &&
        landedRow.current === null &&
        flightSession.current === sessionId &&
        appendedUser
      ) {
        const row = flowRef.current?.querySelector<HTMLElement>(
          `[data-abs-index="${recordStart + record.length - 1}"]`,
        );
        if (row !== null && row !== undefined) {
          row.style.visibility = "hidden";
          landedRow.current = row;
          // What is left of the flight, the landing hold, and a margin.
          const left = Math.max(
            0,
            OUTGOING_FLIGHT_MS - (performance.now() - flightStartedAt.current),
          );
          landingGuard.current = window.setTimeout(
            () => {
              landingGuard.current = null;
              outgoingRise.cancel();
              if (outgoingSettleTimer.current !== null) {
                window.clearTimeout(outgoingSettleTimer.current);
                outgoingSettleTimer.current = null;
              }
              clearLanding();
              setHidePendingUser(false);
              setOutgoingClone(null);
              composerRef.current?.classList.remove("is-glass");
            },
            left + SHADOW_SETTLE_MS + LANDING_GUARD_MARGIN_MS,
          );
          return;
        }
      }
      clearLanding();
      outgoingRise.cancel();
      if (outgoingSettleTimer.current !== null) {
        window.clearTimeout(outgoingSettleTimer.current);
        outgoingSettleTimer.current = null;
      }
      setOutgoingClone(null);
      setHidePendingUser(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    if (!appeared) return;
    // Consumed on EVERY send edge, flight or not, so a lift-off point armed
    // for a send that ends up not flying can never launch a later one.
    launchRef.current = takeLaunch?.() ?? null;
    // A fresh send while a previous landing hold is still fading: the stale
    // timer must not unhide the bubble this flight is about to fly for.
    if (outgoingSettleTimer.current !== null) {
      window.clearTimeout(outgoingSettleTimer.current);
      outgoingSettleTimer.current = null;
    }
    // …and a previous flight's landed row shows as it is.
    clearLanding();
    if (
      overlayRef.current === null ||
      composerRef.current === null ||
      reduced ||
      // Reading history: the send no longer yanks the pane (see the send
      // effect), so this clone's destination — the flow bubble's slot — is
      // below the fold. Flying to it would launch the bubble off the bottom
      // edge of a view the reader never asked to leave. Let the bubble land
      // in the flow unseen, exactly like the reduced-motion path.
      //
      // A DISCLOSURE unpin does not count as reading history, and must be
      // tested the same way here as in the send effect below — the two
      // decisions have to agree or the send hands its travel to a flight that
      // was never armed. Expanding a detail pane and then sending lost the
      // animation entirely until this matched (owner 2026-08-10).
      isReadingHistory()
    ) {
      // No overlay/composer or reduced motion → the flow bubble shows directly,
      // and nothing will fly. Recorded because the send effect below decides
      // whether to hand its travel to a flight that may not exist, and this
      // layout effect runs FIRST in the same commit, so the answer is current.
      outgoingFlightArmedRef.current = false;
      return;
    }
    outgoingFlightArmedRef.current = true;
    flightStartedAt.current = performance.now();
    flightSession.current = sessionId;
    setHidePendingUser(true);
    // The clone carries the message's pictures too (set in the same store
    // emit as pendingUser, so this commit sees them): the strip's images
    // lift off with the bubble instead of popping in at the landing. The
    // hidden pending row is already in the DOM (this is a layout effect),
    // so its strip's width can be measured for the clone to reproduce.
    const rowStrip =
      pendingUserBubbleRef.current?.parentElement?.querySelector(
        ".message-images",
      );
    const imagesWidth = rowStrip?.getBoundingClientRect().width;
    setOutgoingClone({
      text: pendingUser,
      images: pendingEchoImages,
      ...(imagesWidth !== undefined && imagesWidth > 0
        ? { imagesWidthPx: imagesWidth }
        : {}),
    });
  }, [pendingUser, reduced]);

  // Animate once the clone has mounted (cloneRef attaches only after the portal
  // commits — measuring in the detection effect via rAF raced the commit and
  // left the clone unpositioned at the overlay's top-left). FLIP-style: measure
  // the real flow bubble's slot (held in layout via visibility:hidden) and rise
  // the clone to exactly that rect so it lands where the bubble actually goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (outgoingClone === null) return;
    const el = cloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = pendingUserBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    // Diagonal lift: start at the composer's left (the input) — or, for a
    // held message (ADR 0063), at its card's own spot above the composer —
    // and settle at the flow bubble's actual slot (right-aligned, wherever
    // it lands in the flow).
    const launch = launchRef.current;
    const startLeft =
      launch !== null ? launch.left - ws.left : comp.left + 20 - ws.left;
    const startTop =
      launch !== null ? launch.top - ws.top : comp.top - ws.top + 6;
    const targetLeft = dest.left - ws.left;
    // `dest` is where the slot IS, and that is where the clone lands (2026-07-30).
    // It used to subtract the scroll still owed by an in-flight send glide,
    // because the page climbed into the reserved room WHILE the bubble crossed
    // it — the clone had to aim at where the slot would end up. The two are
    // sequenced now: the send parks at the bottom of the real content and the
    // climb waits for this flight's settle, so nothing is owed and the slot
    // cannot move underneath it.
    const targetTop = dest.top - ws.top;
    el.style.left = `${Math.round(startLeft)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    outgoingRise.start({
      el,
      from: { left: startLeft, top: startTop },
      to: { left: targetLeft, top: targetTop },
      durationMs: OUTGOING_FLIGHT_MS,
      easing: easeOutCubic,
      // Runs the flight on the COMPOSITOR (see useRiseAnimation): this rise
      // overlaps the heaviest main-thread moment in the app — the committed
      // turn's style/layout/paint plus, on a full page, the headroom glide —
      // and on a slow machine it used to freeze with it.
      cssEasing: E_OUT_CUBIC,
      // A sidebar toggle or the rail gutter easing in mid-flight moves the
      // slot with no window resize — settle early on a flow WIDTH change
      // (deferred-fix 2026-07-31).
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        // Landing hold: the clone is parked exactly on the slot; keep it
        // there while `.is-settled` fades its flight shadows (the float
        // ::after, and — user variant — the rest shadow, since the real
        // user bubble carries none), THEN swap. Unmounting on this commit
        // popped the shadows off with no transition (owner 2026-08-27).
        // The flight reported in: its guard is not needed. A row that landed
        // mid-flight stays hidden through the hold, as the echo would have.
        if (landingGuard.current !== null) {
          window.clearTimeout(landingGuard.current);
          landingGuard.current = null;
        }
        outgoingSettleTimer.current = window.setTimeout(() => {
          outgoingSettleTimer.current = null;
          clearLanding();
          setHidePendingUser(false);
          setOutgoingClone(null);
        }, SHADOW_SETTLE_MS);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [outgoingClone]);

  // The record this commit saw, for the next commit's append check. Declared
  // AFTER the detection effect, so that one reads the previous commit's.
  useLayoutEffect(() => {
    prevRecord.current = record;
  }, [record]);

  // Unmounted mid-landing: no row stays hidden, no guard fires later.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs only, on unmount
  useEffect(() => () => clearLanding(), []);

  // The optimistic echo's send time, stamped once per pending message: a
  // fresh ISO string per render would change the bubble's `at` prop on every
  // reveal frame and defeat its memo. `pendingUser` always passes through
  // null between sends, so the memo cannot serve a stale stamp to a repeat
  // of the same text.
  const pendingUserAt = useMemo(
    () => (pendingUser === null ? undefined : new Date().toISOString()),
    [pendingUser],
  );

  /** Whether the send in this commit will fly a clone (the detection layout
   *  effect's verdict) — read by the send's follow in the same commit. */
  const isFlightArmed = useCallback(
    (): boolean => outgoingFlightArmedRef.current,
    [],
  );

  return {
    pendingEchoImages,
    pendingUserAt,
    outgoingClone,
    hidePendingUser,
    cloneRef,
    pendingUserBubbleRef,
    isFlightArmed,
  };
}
