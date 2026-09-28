import { useEffect, useRef, useState } from "react";
import { journeyMarkAfterPaint, journeyMarkAt } from "../../lib/journey.js";
import { holdLaunch, releaseLaunch } from "../../lib/launch-gate.js";
import type { SegmentData } from "./ascii-renderer.js";
import { releaseOpeningGlyphSheet } from "./glyph-sheet.js";
import {
  OpeningAsciiCanvas,
  type OpeningFirstFrame,
} from "./OpeningAsciiCanvas.js";
import { pickOpeningSegment } from "./pick-opening-segment.js";

/** Fallback dissolve duration (ms), used only until the canvas reports the real
 *  one (the [38%, 94%] slice of playback) at dissolve-start. */
const CURTAIN_MS = 700;

/** At the first drawn frame, not at the segment's load: the draw worker says
 *  when it committed that frame; a frame drawn here is marked after paint.
 *  The mark's detail says how it was drawn (the CI opening probe reads it). */
const markOpeningPainted = (frame: OpeningFirstFrame): void => {
  const detail = { host: frame.host, sheet: frame.sheet };
  if (frame.atEpochMs === undefined) {
    journeyMarkAfterPaint("launch:opening-painted", detail);
  } else {
    journeyMarkAt("launch:opening-painted", frame.atEpochMs, detail);
  }
};

export interface OpeningAsciiProps {
  /** Called once when the opening sequence (play + fade-out) finishes, or if
   *  the segment fails to load. The parent then unmounts the overlay. */
  readonly onDone: () => void;
  /** Called once when the splash STARTS fading out (the play finished). The
   *  parent reveals the workbench here so it fades IN as the frost fades OUT —
   *  the settled connect screen emerging instead of popping in afterwards. */
  readonly onFadeStart?: () => void;
  /** Test seam: choose + load a segment. Defaults to the real random picker. */
  readonly loadSegment?: () => Promise<SegmentData>;
}

/**
 * Full-window opening splash overlay. Loads one random ASCII segment, fades
 * in (CSS), plays it once, cross-fades out, then calls onDone. Always plays
 * (no skip, no reduced-motion branch — the opening is part of Herta's
 * identity, per the design spec).
 */
export function OpeningAscii(props: OpeningAsciiProps): JSX.Element {
  const [data, setData] = useState<SegmentData | null>(null);
  const [fadingOut, setFadingOut] = useState(false);
  // Dissolve duration (ms), reported by the canvas at dissolve-start. Drives both
  // the overlay's opacity transition and the onDone unmount so they span the
  // adopted [38%, 94%] slice of playback (the figure dissolves over the same).
  const [dissolveMs, setDissolveMs] = useState(CURTAIN_MS);
  const onDoneRef = useRef(props.onDone);
  onDoneRef.current = props.onDone;
  const onFadeStartRef = useRef(props.onFadeStart);
  onFadeStartRef.current = props.onFadeStart;
  // Single-fire guard + tracked fade-out timer (cleared on unmount) so a late
  // timer can't call onDone after the overlay is gone.
  const completedRef = useRef(false);
  const fadeTimerRef = useRef<number>();

  // The launch gate (lib/launch-gate.ts): closed from this FIRST render —
  // render runs before any effect of the tree the splash covers — so the
  // rail's GPU setup waits for the opening instead of racing it. Released
  // below as the opening plays and ends; the unmount releases it too.
  const heldRef = useRef(false);
  if (!heldRef.current) {
    heldRef.current = true;
    holdLaunch();
  }

  useEffect(() => {
    let cancelled = false;
    const loader = props.loadSegment ?? pickOpeningSegment();
    loader()
      .then((seg) => {
        if (cancelled) return;
        setData(seg);
        releaseLaunch("opening");
      })
      .catch(() => {
        if (cancelled) return;
        releaseLaunch("settled");
        releaseOpeningGlyphSheet();
        onDoneRef.current();
      });
    return () => {
      cancelled = true;
      if (fadeTimerRef.current !== undefined) {
        window.clearTimeout(fadeTimerRef.current);
      }
      releaseLaunch("settled");
    };
  }, [props.loadSegment]);

  const handleComplete = (ms: number): void => {
    if (completedRef.current) return;
    completedRef.current = true;
    setDissolveMs(ms);
    setFadingOut(true);
    onFadeStartRef.current?.();
    fadeTimerRef.current = window.setTimeout(() => {
      releaseLaunch("settled");
      // The opening is over: its glyph sheet's pixels go (the draw worker's
      // copy goes with the worker).
      releaseOpeningGlyphSheet();
      onDoneRef.current();
    }, ms);
  };

  return (
    <div
      className={`opening-ascii${fadingOut ? " is-out" : ""}`}
      style={fadingOut ? { transitionDuration: `${dissolveMs}ms` } : undefined}
      data-testid="opening-ascii"
    >
      {/* Mounted before the segment loads: its draw worker starts now, in
          the load's shadow. */}
      <OpeningAsciiCanvas
        data={data}
        onComplete={handleComplete}
        onFirstFrame={markOpeningPainted}
      />
    </div>
  );
}
