import { useEffect, useRef } from "react";
import { useDisconnected } from "../../hooks/useDisconnected.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { afterLaunch } from "../../lib/launch-gate.js";
import { useVoicePlaying } from "../../voice/useVoicePlaying.js";
import { morphFlightActive } from "../Workspace/morph-flight.js";
import {
  AURA_ENERGY_FLOOR,
  clamp,
  createAuraAnimator,
  displayAuraState,
  resolveAura,
  type TideOptions,
} from "./aura-engine.js";
import {
  type AuraLocations,
  type AuraPalette,
  auraLocations,
  drawAuraFrame,
  LIGHT_AURA_PALETTE,
  readAuraPalette,
} from "./aura-gl.js";
import { AURA_SHADER_SOURCE } from "./auraShader.js";
import { useSpeechEnvelope } from "./useSpeechEnvelope.js";
import { initialEnvelope, stepEnvelope } from "./wave-engine.js";
import {
  createProgram,
  isSoftwareRenderer,
  QUAD_VERTEX_SOURCE,
} from "./webgl.js";

/* The tide's polish (2026-09-30): which of the optional upgrades the app
   draws (aura-engine TideOptions; TIDE_CLASSIC is the tide as it was). All
   of them — the owner's pick from a live gallery of each alone. */
const TIDE: TideOptions = {
  smoothBreath: true,
  settle: true,
  window: 1,
  crest: 1,
  prism: 0.35,
};
const MAX_FRAME_DT_S = 0.05;
/* Idle frame governor (perf 2026-07-13): at rest the wave draws a 2.8s
   breathing cycle — full display rate (60–165fps) buys nothing visually
   but keeps the GPU out of idle forever. When CALM (listening, energy at
   the floor, no recent state change) frames are spaced ≥30ms (~33fps);
   speech, voice cues, or a state transition restore full rate instantly
   (the gate reads the PREVIOUS drawn frame's calmness, so the first
   energetic frame is at most one throttled interval late). */
const CALM_MIN_FRAME_MS = 30;
const CALM_HOLD_MS = 1500; // full rate for this long after any state change
const CALM_ENERGY = 0.04; // env.fast below this counts as at-rest
const CALM_SETTLE = 0.03; // the calm after speech still moving above this
/* Parking (perf 2026-09-03): the governor's floor is ~33fps FOREVER while a
   session is open — `document.hidden` never flips for a window that is
   merely behind another one, so an app left open all day kept the most
   expensive shader in the app running for nobody. When the window is not
   focused AND the wave has been calm for this long, the loop parks on its
   last frame (no rAF, no timer). Focus, a state change, or a voice cue
   restarts it; while the window IS focused nothing changes — the breath is
   part of the product. */
const PARK_UNFOCUSED_MS = 5000;
/* Resolution cap (perf 2026-07-13): the tide shader is the most expensive
   per-fragment pass in the app (a 30-step march × 4-iteration warp), and
   the canvas spans the composer's full width. HORIZONTAL detail varies
   slowly (the wave's wiggles), so the backing width is capped and the GPU
   upscales; vertical resolution stays at full dpr — the hairline's
   CRISPNESS lives in the y axis. ~3.5× fewer fragments at dpr-2
   fullscreen, no visible change in the band. (Since 2026-09-30 the rows
   above the band's reach return at once — see auraShader.ts.) */
const WAVE_MAX_BACKING_W = 1600;

/**
 * The voice card's aura: a WebGL fragment-shader visualizer ported from
 * reference_UX_design/speech-visual-UX, rendering the tide-wave geometry from
 * reference_UX_design/glass-wave-study (2026-07-05). State (disconnected/
 * listening/speaking) comes from the active session; energy from Herta's
 * revealed-text rhythm (useSpeechEnvelope); the easing and clocks are the
 * pure animator in aura-engine.ts, the upload aura-gl.ts. Reduced motion pins
 * the calm listening breath. Falls back to a static CSS aura when WebGL is
 * unavailable. Renderer-local only.
 */
export function AuraVisual(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Select only what displayAuraState reads (DeviceCard precedent): the
  // full-snapshot subscription re-rendered this component on every
  // streaming delta, which the shader loop never needed — energy arrives
  // through the kicks refs, not through renders.
  const snapshot = useSessionSelector(
    (s) => ({ sessionId: s.sessionId, status: s.status }),
    shallowEqualObjects,
  );
  const reduced = useReducedMotion();
  const kicks = useSpeechEnvelope();
  // A playing voice clip forces the speaking state so audio-only cues (the
  // easter egg) animate the aura even though they stream no text.
  const voicePlaying = useVoicePlaying();
  // While disconnected the utility rail is off-screen (translated past the
  // right edge, opacity 0) yet still mounted — the shader was rendering full-rate WebGL
  // forever over the connect screen. Gate the loop like document.hidden.
  const disconnected = useDisconnected();

  // Latest state for the loop to read (avoids re-running the GL setup effect).
  const live = useRef({
    auraState: displayAuraState(snapshot, voicePlaying),
    reduced,
    hidden: disconnected,
  });
  live.current = {
    auraState: displayAuraState(snapshot, voicePlaying),
    reduced,
    hidden: disconnected,
  };
  // The GL effect exposes its start/stop here so the gating effect below can
  // drive them without re-running the (expensive) GL setup.
  const loopControls = useRef<{
    start: () => void;
    stop: () => void;
  } | null>(null);
  useEffect(() => {
    const c = loopControls.current;
    if (c === null) return;
    if (disconnected) c.stop();
    else c.start();
  }, [disconnected]);
  // A parked loop (see PARK_UNFOCUSED_MS) wakes on anything that changes
  // what it would draw: the session status, a voice cue, reduced motion.
  // start() is idempotent while the loop runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the values are wake triggers the loop reads through `live`, not inputs of the effect body
  useEffect(() => {
    if (!disconnected) loopControls.current?.start();
  }, [
    disconnected,
    snapshot.status,
    snapshot.sessionId,
    voicePlaying,
    reduced,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // The GL setup waits for the launch to settle (lib/launch-gate.ts): at a
    // cold start it cost ~200 ms of synchronous GPU round trips right before
    // the opening's first frame, for a wave hidden behind the splash that
    // does not even draw on the connect screen.
    const setUp = (): (() => void) | undefined => {
      const gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      });
      // No WebGL, or only a CPU rasterizer: the static CSS aura. A software
      // context would redraw this decoration at display rate on the CPU
      // (platform review 2026-09-23).
      if (gl === null || isSoftwareRenderer(gl)) {
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.dataset.fallback = "true";
        return;
      }
      // GL objects live in rebuildable closure state (audit 2026-07-13 T2.1):
      // a context loss (Windows TDR, driver update, sleep-wake) invalidates
      // every program/buffer/location, so setup must be re-runnable on
      // webglcontextrestored — not once-per-mount.
      let program: WebGLProgram | null = null;
      let buf: WebGLBuffer | null = null;
      let loc: AuraLocations | null = null;
      const buildGl = (): boolean => {
        try {
          program = createProgram(gl, QUAD_VERTEX_SOURCE, AURA_SHADER_SOURCE);
        } catch (e) {
          console.error("Aura shader error:", e);
          canvas.dataset.fallback = "true";
          return false;
        }
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
          gl.STATIC_DRAW,
        );
        loc = auraLocations(gl, program);
        // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL API method, not a React hook
        gl.useProgram(program);
        gl.enableVertexAttribArray(loc.position);
        gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
        gl.disable(gl.BLEND);
        return true;
      };
      if (!buildGl()) return;

      const env = initialEnvelope();
      // Theme-aware wave (night-mode slice 2 + visibility fix 2026-07-13):
      // the tint, the glass-sheet base value and the catch-light's prism
      // live in CSS (--aura-*; dark overrides them — light sheets on the dark
      // glass), re-read when the theme controller re-stamps <html
      // data-theme>. Missing tokens fall back to the light values.
      let palette: AuraPalette = LIGHT_AURA_PALETTE;
      const readThemeVars = (): void => {
        palette = readAuraPalette(canvas);
      };
      readThemeVars();
      const mo =
        typeof MutationObserver !== "undefined"
          ? new MutationObserver(readThemeVars)
          : null;
      mo?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      // Canvas size cached via ResizeObserver: the render loop used to call
      // getBoundingClientRect every frame, which forces synchronous layout in
      // any frame where the DOM is dirty (i.e. every streaming frame).
      let rectW = 0;
      let rectH = 0;
      const measure = (): void => {
        const r = canvas.getBoundingClientRect();
        rectW = r.width;
        rectH = r.height;
      };
      measure();
      const ro =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(measure)
          : null;
      ro?.observe(canvas);
      // Seed the interpolated uniforms from the MOUNT-time state so that if the
      // first animated frame doesn't run until later (e.g. the window/splash was
      // still settling at launch), it lerps FROM the resting state instead of
      // snapping to whatever state is current then. At launch the app opens
      // disconnected, so a later connect animates the aura disconnected→listening
      // rather than jumping straight to listening (user 2026-06-20).
      const seed = resolveAura(
        live.current.auraState,
        live.current.reduced,
        AURA_ENERGY_FLOOR,
      );
      const animator = createAuraAnimator(seed.state, seed.energy, TIDE);
      let last = performance.now();
      let raf: number | null = null;
      let idleTimer: number | null = null;
      // Governor state: `calm` is judged at the END of each drawn frame (the
      // gate below reads the previous frame's verdict); stateChangedTs keeps
      // full rate through transitions so the ~0.5s uniform lerps stay smooth.
      let calm = false;
      let prevResolvedState: string | null = null;
      let stateChangedTs = performance.now();
      // Parking state: when the calm run began, and whether the window has
      // focus (tracked by event — `document.hidden` does not cover "behind
      // another window").
      let calmSince: number | null = null;
      let focused =
        typeof document.hasFocus === "function" ? document.hasFocus() : true;

      const render = (now: number): void => {
        raf = null;
        // Park: calm for PARK_UNFOCUSED_MS with the window unfocused — stop
        // re-arming. `raf` and `idleTimer` are both null here, so a later
        // start() (focus, a state change) simply resumes.
        if (
          calm &&
          !focused &&
          calmSince !== null &&
          now - calmSince > PARK_UNFOCUSED_MS
        ) {
          return;
        }
        // Idle frame governor: at rest, space frames to ~33fps. `last` only
        // advances on DRAWN frames, so dt spans the skipped gap naturally
        // (clamped by MAX_FRAME_DT_S). The wait rides a TIMER, not rAF
        // (audit T3.7): re-arming rAF here woke the CPU at the full display
        // rate — up to 165×/s on a fast panel — only to skip; the timer
        // sleeps out the remainder, then rejoins the rAF clock to draw.
        // A morph in flight takes the same spacing as being at rest — for the
        // opposite of the obvious reason (2026-07-30, see morph-flight.ts). A
        // send changes the aura state, so the loop asks for full rate exactly
        // when the main thread is committing a turn, and gets 12–17fps of
        // stutter for it. Riding the timer instead measured 28–32fps steady:
        // requesting less actually delivers more here, because a timer keeps its
        // slot where a rAF request has to win one.
        // Read LIVE, not from the previous frame's `calm` verdict, so the first
        // frame of a flight is already spaced.
        if ((calm || morphFlightActive()) && now - last < CALM_MIN_FRAME_MS) {
          idleTimer = window.setTimeout(
            () => {
              idleTimer = null;
              if (raf === null) raf = requestAnimationFrame(render);
            },
            CALM_MIN_FRAME_MS - (now - last),
          );
          return;
        }
        const l = loc;
        if (l === null) return; // context lost mid-frame — the loop is dead
        const dt = Math.min(MAX_FRAME_DT_S, (now - last) / 1000);
        last = now;

        stepEnvelope(env, dt * 1000, kicks.drainKicks());
        const { auraState, reduced: red } = live.current;
        const resolved = resolveAura(auraState, red, clamp(env.fast, 0, 1));
        if (resolved.state !== prevResolvedState) {
          prevResolvedState = resolved.state;
          stateChangedTs = now;
        }

        const frame = animator.step(dt, resolved.state, resolved.energy);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // Backing width capped (see WAVE_MAX_BACKING_W); height keeps full dpr.
        const w = Math.max(
          1,
          Math.floor(Math.min((rectW || 860) * dpr, WAVE_MAX_BACKING_W)), // jsdom reports 0 → the composer reference size (≈860×78)
        );
        const h = Math.max(1, Math.floor((rectH || 78) * dpr)); // jsdom reports 0 → the composer reference size (≈860×78)
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, w, h);
        }

        drawAuraFrame(gl, l, frame, { width: w, height: h }, palette);

        // Judge NEXT frame's throttle from this one: at rest (listening, floor
        // energy, transitions settled, the calm after speech done) the
        // governor spaces frames out.
        calm =
          resolved.state === "listening" &&
          env.fast < CALM_ENERGY &&
          frame.settle < CALM_SETTLE &&
          now - stateChangedTs > CALM_HOLD_MS;
        if (!calm) calmSince = null;
        else if (calmSince === null) calmSince = now;
        // Diagnostics handle (a plain JS property — never a DOM attribute, so
        // no style/layout impact): lets probes count real draws per second to
        // verify the governor. Harmless in production.
        (canvas as HTMLCanvasElement & { __draws?: number }).__draws =
          ((canvas as HTMLCanvasElement & { __draws?: number }).__draws ?? 0) +
          1;

        raf = requestAnimationFrame(render);
      };
      let contextLost = false;
      const start = (): void => {
        // All gates: a lost GL context, a hidden document, and an off-screen
        // rail each keep the loop off. `idleTimer` counts as running — the
        // calm governor is mid-sleep, not stopped.
        if (
          raf === null &&
          idleTimer === null &&
          !contextLost &&
          !document.hidden &&
          !live.current.hidden
        ) {
          // A (re)start always draws its first frame and re-judges: the park
          // gate reads the PREVIOUS frame's calm verdict, which is exactly what
          // parked the loop — left standing, a wake would park again at once.
          calm = false;
          calmSince = null;
          last = performance.now();
          raf = requestAnimationFrame(render);
        }
      };
      const stop = (): void => {
        if (raf !== null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
        if (idleTimer !== null) {
          window.clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const onVisibility = (): void => {
        if (document.hidden) stop();
        else start();
      };
      // Window focus: a blur lets the loop park itself once calm (the render
      // gate above); a focus wakes a parked loop. Only the flag flips on blur —
      // a state change while unfocused still draws at the calm rate.
      const onFocus = (): void => {
        focused = true;
        start();
      };
      const onBlur = (): void => {
        focused = false;
      };
      // Context loss/restore (audit 2026-07-13 T2.1): without these, a GPU
      // reset left every GL call a no-op with the rAF loop running dead — an
      // invisible wave until app restart. preventDefault signals the browser
      // we handle restoration (webglcontextrestored never fires otherwise);
      // the CSS fallback shows while the context is gone.
      const onContextLost = (e: Event): void => {
        e.preventDefault();
        contextLost = true;
        stop();
        canvas.dataset.fallback = "true";
      };
      const onContextRestored = (): void => {
        contextLost = false;
        if (!buildGl()) return; // rebuild failed — the fallback stays
        delete canvas.dataset.fallback;
        start();
      };
      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      loopControls.current = { start, stop };
      start();
      return () => {
        stop();
        loopControls.current = null;
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
        ro?.disconnect();
        mo?.disconnect();
        gl.deleteBuffer(buf);
        gl.deleteProgram(program);
      };
    };
    let teardown: (() => void) | undefined;
    const cancel = afterLaunch("settled", () => {
      teardown = setUp();
    });
    return () => {
      cancel();
      teardown?.();
    };
  }, [kicks]);

  return (
    <div className="aura-frame">
      <canvas
        ref={canvasRef}
        className="aura-canvas"
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="aura-fallback" />
    </div>
  );
}
