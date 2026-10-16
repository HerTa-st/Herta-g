import { useCallback, useEffect, useRef, useState } from "react";
import { deviceSceneAssetUrl } from "../../../../shared/device-scene.js";
import type { BanzhuanDeviceState } from "../../../hooks/useDeviceState.js";
import { useReducedMotion } from "../../../hooks/useReducedMotion.js";
import type { ResolvedTheme } from "../../../hooks/useResolvedTheme.js";
import { afterLaunch } from "../../../lib/launch-gate.js";
import { detectDeviceSceneBackend } from "./capability.js";
import type { DeviceSceneHandle, DeviceSceneInputs } from "./scene.js";
import {
  IDLE_MOUNT_IDLE_TIMEOUT_MS,
  IDLE_MOUNT_MAX_WAIT_MS,
  IDLE_MOUNT_QUIET_MS,
  scheduleIdle,
} from "./use-idle-mount.js";

/** A developer's opt-in for GPU timestamps in the canvas dataset. */
function profileRequested(): boolean {
  try {
    return localStorage.getItem("herta.deviceScene.profile") === "1";
  } catch {
    return false;
  }
}

export interface DeviceSceneProps {
  readonly state: BanzhuanDeviceState;
  readonly theme: ResolvedTheme;
  /** Off-screen gate (disconnected rail, docked viewer) — stops the loop. */
  readonly paused: boolean;
  /** The drag hook's lift target in CSS px (0 when released). */
  readonly liftPx: number;
  /** true once the scene has presented a frame and owns the card; false
   *  when it cannot (no GPU path, a load failure, a lost device). */
  readonly onLive: (live: boolean) => void;
  /** A small picture of the live scene (§2.13's frosted glass for the
   *  next launch): shortly after live, after a theme change, and every
   *  ten minutes while drawing. */
  readonly onSnapshot?: (dataUrl: string) => void;
  /** A lost scene that will be rebuilt: the card shows its glass — the
   *  scene's own last picture — until the rebuild goes live or fails, not
   *  the flat art, a different drawing of the device, for the seconds
   *  between. Absent: the loss reads as not-live. */
  readonly onPending?: () => void;
}

/** After live / a theme flip: past the focus cross-fade and the theme's
 *  own easing through dusk. */
const SNAPSHOT_SETTLE_MS = 3000;
const SNAPSHOT_REFRESH_MS = 10 * 60_000;

/** How long after a lost GPU context the scene is rebuilt: the GPU process
 *  restarts and restores contexts within a second or two. */
export const SCENE_REBUILD_DELAY_MS = 3000;
/** Rebuilds allowed in a row before the card stays flat. */
export const SCENE_REBUILD_LIMIT = 3;
/** A scene that stayed live this long has recovered: its next loss starts
 *  a fresh count (a laptop's sleep loses the context once a day, not in a
 *  loop). */
const SCENE_STABLE_MS = 60_000;

/**
 * The 3D device card, recovering from a lost GPU context (UX review
 * 2026-09-22, item 23). A lost context or device used to leave the flat art
 * up until the app restarted — a sleep and resume, a driver update, a GPU
 * reset. Now a loss rebuilds the scene after a pause on a FRESH canvas (the
 * lost one's context is dead): the build is keyed by a generation, so the
 * rebuild is an ordinary mount. Bounded: a scene that keeps losing its
 * context stops being rebuilt; one that stayed live a minute starts over.
 */
export function DeviceScene(props: DeviceSceneProps): JSX.Element {
  const [generation, setGeneration] = useState(0);
  const rebuilds = useRef(0);
  const liveAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLive = useRef(props.onLive);
  onLive.current = props.onLive;
  const onPending = useRef(props.onPending);
  onPending.current = props.onPending;
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const handleLive = useCallback((live: boolean): void => {
    if (live) liveAt.current = Date.now();
    onLive.current(live);
  }, []);
  const handleLost = useCallback((): void => {
    const since = liveAt.current;
    if (since !== null && Date.now() - since > SCENE_STABLE_MS) {
      rebuilds.current = 0;
    }
    liveAt.current = null;
    if (rebuilds.current >= SCENE_REBUILD_LIMIT) {
      onLive.current(false);
      return;
    }
    rebuilds.current += 1;
    // A flaky driver showed the flat art and the scene by turns, three
    // times over (release review 2026-10-13): the glass holds the place.
    const pending = onPending.current;
    if (pending !== undefined) pending();
    else onLive.current(false);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setGeneration((g) => g + 1);
    }, SCENE_REBUILD_DELAY_MS);
  }, []);
  return (
    <DeviceSceneBuild
      key={generation}
      {...props}
      onLive={handleLive}
      onLost={handleLost}
    />
  );
}

/**
 * One build of the 3D device card's canvas (ADR 0057 §4). Mounts a canvas
 * immediately, probes the GPU path, then lazily imports the three.js scene
 * module and builds the scene; `onLive(true)` fires only after a first
 * frame, so the flat renders stay up until there is something to show. Any
 * other failure — before or after — is `onLive(false)` and the card is
 * flat again; a LOSS (the scene's fallback) reports `onLost`, which the
 * wrapper above answers with a rebuild, or with not-live past its limit. The scene's
 * inputs ride a ref so the mount effect runs once.
 */
function DeviceSceneBuild(
  props: DeviceSceneProps & { readonly onLost: () => void },
): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const inputs: DeviceSceneInputs = {
    state: props.state,
    theme: props.theme,
    reducedMotion,
    paused: props.paused,
    liftPx: props.liftPx,
  };
  const live = useRef(inputs);
  live.current = inputs;
  const onLive = useRef(props.onLive);
  onLive.current = props.onLive;
  const onSnapshot = useRef(props.onSnapshot);
  onSnapshot.current = props.onSnapshot;
  const onLost = useRef(props.onLost);
  onLost.current = props.onLost;
  const handle = useRef<DeviceSceneHandle | null>(null);
  const [isLive, setIsLive] = useState(false);

  // The frosted-glass picture: taken from the live scene itself, not the
  // flat art (§2.13). Never while parked — nothing would have changed.
  const snapshotTimers = useRef<{
    settle: ReturnType<typeof setTimeout> | null;
    refresh: ReturnType<typeof setInterval> | null;
  }>({ settle: null, refresh: null });
  const takeSnapshot = useCallback((): void => {
    const scene = handle.current;
    if (scene === null || live.current.paused) return;
    void scene.snapshot().then((url) => {
      if (url !== null && handle.current === scene) onSnapshot.current?.(url);
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    let built: DeviceSceneHandle | null = null;
    // The build's own abort (ADR 0057 §6.5): before this, an unmount
    // mid-build had nothing to dispose and the build ran to completion.
    const abort = new AbortController();
    const build = async (): Promise<void> => {
      const backend = await detectDeviceSceneBackend();
      if (cancelled) return;
      if (backend === null) {
        onLive.current(false);
        return;
      }
      const { createDeviceScene } = await import("./scene.js");
      if (cancelled) return;
      built = await createDeviceScene({
        canvas,
        forceWebGL: backend === "webgl2",
        assetUrl: deviceSceneAssetUrl,
        initial: live.current,
        profile: profileRequested(),
        signal: abort.signal,
        // The synchronous first frame stalls the main thread for ~0.5 s;
        // after the seconds of asynchronous compile, wait for the user to
        // be quiet again before taking it (§2.12).
        awaitQuiet: () =>
          new Promise<void>((resolve) => {
            scheduleIdle(resolve, {
              settleMs: 0,
              quietMs: IDLE_MOUNT_QUIET_MS,
              idleTimeoutMs: IDLE_MOUNT_IDLE_TIMEOUT_MS,
              maxWaitMs: IDLE_MOUNT_MAX_WAIT_MS,
            });
          }),
        // Not-live or pending is the wrapper's call: it knows whether a
        // rebuild follows.
        onFallback: () => {
          handle.current = null;
          onLost.current();
        },
      });
      if (cancelled) {
        built.dispose();
        return;
      }
      handle.current = built;
      built.update(live.current);
      canvas.dataset.backend = built.stats.backend;
      canvas.dataset.loadMs = built.stats.loadMs.toFixed(0);
      canvas.dataset.compileMs = built.stats.compileMs.toFixed(0);
      canvas.dataset.firstFrameMs = built.stats.firstFrameMs.toFixed(0);
      canvas.dataset.presentMs = built.stats.presentMs.toFixed(0);
      // Since the page's time origin — the boot-to-live figure.
      canvas.dataset.liveMs = performance.now().toFixed(0);
      onLive.current(true);
      setIsLive(true);
    };
    // After the opening (the launch gate): the build's asynchronous compile
    // held the GPU process ~0.2 s, and once the opening drew on its worker
    // that time came out of the dissolve's frames (17 → 12 fps, M-opening-3).
    // The scene goes live seconds after the splash lifts either way: its
    // first frame waits for a quiet main thread.
    const cancelGate = afterLaunch("settled", () => {
      build().catch(() => {
        if (!cancelled) onLive.current(false);
      });
    });
    return () => {
      cancelGate();
      cancelled = true;
      abort.abort();
      setIsLive(false);
      // One dispose: `handle.current` and `built` are the same object once
      // the build has landed; before that only `built` (or nothing) exists.
      const scene = handle.current ?? built;
      handle.current = null;
      built = null;
      scene?.dispose();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scene reads the inputs through `live`; the deps are the wake triggers
  useEffect(() => {
    handle.current?.update(live.current);
  }, [props.state, props.theme, props.paused, props.liftPx, reducedMotion]);

  // Snapshots: once settled after live and after each theme flip, then on
  // a slow refresh so the picture follows the clock loosely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme is a trigger, not a read
  useEffect(() => {
    if (!isLive) return;
    const timers = snapshotTimers.current;
    if (timers.settle !== null) clearTimeout(timers.settle);
    timers.settle = setTimeout(takeSnapshot, SNAPSHOT_SETTLE_MS);
    if (timers.refresh === null) {
      timers.refresh = setInterval(takeSnapshot, SNAPSHOT_REFRESH_MS);
    }
    return () => {
      if (timers.settle !== null) clearTimeout(timers.settle);
      timers.settle = null;
      if (!isLive && timers.refresh !== null) {
        clearInterval(timers.refresh);
        timers.refresh = null;
      }
    };
  }, [isLive, props.theme, takeSnapshot]);
  useEffect(
    () => () => {
      const timers = snapshotTimers.current;
      if (timers.settle !== null) clearTimeout(timers.settle);
      if (timers.refresh !== null) clearInterval(timers.refresh);
      timers.settle = null;
      timers.refresh = null;
    },
    [],
  );

  // No aria-hidden: a canvas exposes nothing to assistive tech by itself,
  // and the card's aria-label carries the device state.
  return <canvas ref={canvasRef} className="device-scene-canvas" />;
}
