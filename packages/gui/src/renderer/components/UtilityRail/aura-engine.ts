import type { SessionStatus } from "../../store/session-store.js";

export type AgentAuraState = "disconnected" | "listening" | "speaking";

interface AuraProfile {
  readonly speed: number;
  readonly floor: number;
  readonly scale: number;
  readonly frequency: number;
  readonly brightness: number;
}

/** Locked profiles from the reference (speech-visual-UX `agentStates`).
 *  Amplitude is no longer profile-driven — the tide-wave mapping in
 *  getAuraUniformTarget owns it (glass-wave direction, 2026-07-05). */
export const agentStates: Record<AgentAuraState, AuraProfile> = {
  disconnected: {
    speed: 10,
    floor: 0.08,
    scale: 0.23,
    frequency: 0.4,
    brightness: 1.0,
  },
  listening: {
    speed: 20,
    floor: 0.26,
    scale: 0.3,
    frequency: 0.7,
    brightness: 1.3,
  },
  speaking: {
    speed: 70,
    floor: 0.32,
    scale: 0.3,
    frequency: 1.25,
    brightness: 1.35,
  },
};

/** Resting energy floor used in disconnected and under reduced motion. */
export const AURA_ENERGY_FLOOR = 0.08;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

/** 0→1→0 triangle over `duration`. */
export function mirrorPulse(time: number, duration: number): number {
  const progress = (time % duration) / duration;
  return progress < 0.5 ? progress * 2 : (1 - progress) * 2;
}

/** 0→1→0 over `period` seconds on a sine — a breath with no corners. */
export function breath(time: number, period: number): number {
  return 0.5 - 0.5 * Math.cos((time / period) * Math.PI * 2);
}

/**
 * The tide's polish (2026-09-30), each part optional so each can be seen
 * alone before it ships. TIDE_CLASSIC draws the tide exactly as before.
 */
export interface TideOptions {
  /** Listening breathes on one smooth 2.8 s sine (see getAuraUniformTarget). */
  readonly smoothBreath: boolean;
  /** Speech ending settles: the crests subside over ~0.6 s instead of
   *  ~0.18 s, while the sheets soften and fade a little (stepSettle). */
  readonly settle: boolean;
  /** 0..1 — a window of light drifting along the band while she speaks. */
  readonly window: number;
  /** 0..1 — the sheets standing highest hold more glass and light. */
  readonly crest: number;
  /** 0..1 — the glass tinted jade → blue across its sheets. */
  readonly prism: number;
}

export const TIDE_CLASSIC: TideOptions = {
  smoothBreath: false,
  settle: false,
  window: 0,
  crest: 0,
  prism: 0,
};

/** Map HERTA session state → aura state. */
export function deriveAuraState(s: {
  readonly sessionId: string | null;
  readonly status: SessionStatus;
}): AgentAuraState {
  if (s.sessionId === null) return "disconnected";
  if (s.status === "speaking") return "speaking";
  return "listening"; // idle | thinking
}

/**
 * The aura state to DISPLAY. A currently-playing voice clip forces "speaking" so
 * audio-only cues (e.g. the easter egg, which streams no text) animate the card
 * the same way streamed speech does — except with no session, where it stays
 * "disconnected". Otherwise the session-derived state.
 */
export function displayAuraState(
  s: {
    readonly sessionId: string | null;
    readonly status: SessionStatus;
  },
  voicePlaying: boolean,
): AgentAuraState {
  const base = deriveAuraState(s);
  if (base === "disconnected") return base;
  return voicePlaying ? "speaking" : base;
}

/** Reduced motion: pin the calm listening breath + floor energy (no flutter). */
export function resolveAura(
  state: AgentAuraState,
  reduced: boolean,
  energy: number,
): { state: AgentAuraState; energy: number } {
  if (reduced) return { state: "listening", energy: AURA_ENERGY_FLOOR };
  return { state, energy };
}

export interface AuraUniformTarget {
  readonly speed: number;
  readonly scale: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly brightness: number;
}

/** Target uniforms for the current state + energy + time.
 *
 * Amplitude follows the tide-wave mapping (glass-wave direction, 2026-07-05):
 * uAmplitude sets the crest height of the shader's wave curve (and its warp
 * turbulence), so the waterline rests nearly flat while disconnected, breathes
 * as a hairline while listening, and punches per word while speaking. The
 * study's 0.8 tide geometry factor is folded into these constants. See
 * reference_UX_design/glass-wave-study/. */
export function getAuraUniformTarget(
  state: AgentAuraState,
  energy: number,
  time: number,
  opts: TideOptions = TIDE_CLASSIC,
): AuraUniformTarget {
  const profile = agentStates[state];
  if (state === "disconnected") {
    return {
      speed: profile.speed,
      scale: profile.scale,
      amplitude: 0.064,
      frequency: profile.frequency,
      brightness: profile.brightness,
    };
  }
  if (state === "listening") {
    // The classic breath is two triangles out of step: the crest on a 1.6 s
    // one, the brightness flickering on a 0.7 s one. The smooth breath is ONE
    // sine at the house's breathing period (--agent-breathe-duration, 2.8 s)
    // over the same ranges — no corner at either end of the breath.
    const amp = opts.smoothBreath ? breath(time, 2.8) : mirrorPulse(time, 1.6);
    const glow = opts.smoothBreath ? breath(time, 2.8) : mirrorPulse(time, 0.7);
    return {
      speed: profile.speed,
      scale: profile.scale,
      amplitude: 0.112 + 0.08 * amp,
      frequency: profile.frequency,
      brightness: lerp(1.5, 2.0, glow),
    };
  }
  const sway = Math.sin(time * 2.1);
  const breathDepth = 0.028 + 0.018 * energy;
  return {
    speed: 145,
    scale: 0.3 + breathDepth * sway,
    amplitude: 0.28 + 0.92 * energy,
    frequency: profile.frequency,
    brightness: 1.5,
  };
}

/** Move `v` toward `target` with time constant `tau` over `dtS` seconds —
 *  frame-rate independent. */
const toward = (v: number, target: number, tau: number, dtS: number): number =>
  v + (target - v) * (1 - Math.exp(-dtS / tau));

/**
 * The calm after speech (TideOptions.settle). `speak` follows the speaking
 * state quickly, `after` slowly; the gap between them exists only in the
 * seconds after a stretch of speech. While she speaks it aims at nothing —
 * the gap also opens for a moment as speech STARTS, which is no ending — and
 * `value` eases toward its aim, so speech resuming mid-settle never snaps it.
 */
export interface SettleState {
  speak: number;
  after: number;
  value: number;
}

export const initialSettle = (): SettleState => ({
  speak: 0,
  after: 0,
  value: 0,
});

/** Advance by `dtS` seconds; returns the settle, 0..1. Mutates `s`. */
export function stepSettle(
  s: SettleState,
  speaking: boolean,
  dtS: number,
): number {
  s.speak = toward(s.speak, speaking ? 1 : 0, speaking ? 0.25 : 0.3, dtS);
  s.after = toward(s.after, speaking ? 1 : 0, speaking ? 1.2 : 0.9, dtS);
  const aim = speaking ? 0 : clamp(s.after * (1 - s.speak) * 1.6, 0, 1);
  s.value = toward(s.value, aim, 0.08, dtS);
  return s.value;
}

/** One drawn frame of the tide: the eased uniforms and their clocks. */
export interface AuraFrame {
  speed: number;
  scale: number;
  amplitude: number;
  frequency: number;
  brightness: number;
  /** The shader's iTime: advances faster the faster the tide moves. */
  phase: number;
  /** Seconds since the animator started (wall time; slow drifts). */
  clock: number;
  settle: number;
  focus: number;
  crest: number;
  prism: number;
}

export interface AuraAnimator {
  /** The frame, mutated in place by step() — one object for the loop's life. */
  readonly frame: AuraFrame;
  /** Advance by `dtS` seconds toward the state's targets at this energy. */
  step(dtS: number, state: AgentAuraState, energy: number): AuraFrame;
}

/**
 * The frame loop's easing, pure: AuraVisual's rAF loop calls step() once per
 * drawn frame, tests and the design harnesses drive it with a fixed step.
 * With TIDE_CLASSIC it is exactly the loop the tide always ran — speed,
 * scale, frequency and brightness over ~0.46 s, the crest up in ~50 ms and
 * down in ~180 ms, iTime advancing at 0.3 + speed·0.03 per second. Seeded
 * from the resting state, so a first frame that runs late lerps FROM rest:
 * at launch the app opens disconnected and a later connect animates
 * disconnected → listening (user 2026-06-20).
 */
export function createAuraAnimator(
  seedState: AgentAuraState,
  seedEnergy: number,
  opts: TideOptions = TIDE_CLASSIC,
): AuraAnimator {
  const seed = getAuraUniformTarget(seedState, seedEnergy, 0, opts);
  const settle = initialSettle();
  let shaderTime = 0;
  let speaking = 0;
  const frame: AuraFrame = {
    ...seed,
    phase: 0,
    clock: 0,
    settle: 0,
    focus: 0,
    crest: opts.crest,
    prism: opts.prism,
  };
  return {
    frame,
    step(dtS, state, energy) {
      shaderTime += dtS;
      frame.clock += dtS;
      const t = getAuraUniformTarget(state, energy, shaderTime, opts);
      const ease = 1 - Math.exp(-dtS / 0.46);
      frame.speed = lerp(frame.speed, t.speed, ease);
      frame.scale = lerp(frame.scale, t.scale, ease);
      // The crest lets go slowly once speech has ENDED (the settle) — between
      // words it keeps its quick release, so the rhythm still reads.
      const release = opts.settle && state !== "speaking" ? 0.6 : 0.18;
      frame.amplitude = lerp(
        frame.amplitude,
        t.amplitude,
        1 - Math.exp(-dtS / (t.amplitude > frame.amplitude ? 0.05 : release)),
      );
      frame.frequency = lerp(frame.frequency, t.frequency, ease);
      frame.brightness = lerp(frame.brightness, t.brightness, ease);
      frame.phase += dtS * (0.3 + frame.speed * 0.03);
      frame.settle = opts.settle
        ? stepSettle(settle, state === "speaking", dtS)
        : 0;
      speaking = toward(speaking, state === "speaking" ? 1 : 0, 0.46, dtS);
      frame.focus = speaking * opts.window;
      return frame;
    },
  };
}
