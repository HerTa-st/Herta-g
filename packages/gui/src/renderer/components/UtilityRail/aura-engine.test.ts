import { describe, expect, it } from "vitest";
import {
  type AgentAuraState,
  AURA_ENERGY_FLOOR,
  createAuraAnimator,
  deriveAuraState,
  displayAuraState,
  getAuraUniformTarget,
  initialSettle,
  lerp,
  resolveAura,
  type SettleState,
  stepSettle,
  TIDE_CLASSIC,
  type TideOptions,
} from "./aura-engine.js";

const POLISHED: TideOptions = {
  smoothBreath: true,
  settle: true,
  window: 1,
  crest: 1,
  prism: 0.35,
};

describe("createAuraAnimator (the tide's frame loop, pure — 2026-09-30)", () => {
  it("with TIDE_CLASSIC it is exactly the loop AuraVisual ran before", () => {
    // The loop as it stood inline in AuraVisual.tsx (git HEAD 2026-09-30).
    const old = {
      ...getAuraUniformTarget("disconnected", AURA_ENERGY_FLOOR, 0),
    };
    let shaderTime = 0;
    let phaseTime = 0;
    const a = createAuraAnimator("disconnected", AURA_ENERGY_FLOOR);
    const states: AgentAuraState[] = ["listening", "speaking", "listening"];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 900; i += 1) {
      const dt = 0.004 + rnd() * 0.046;
      const state = states[Math.floor(i / 300)] ?? "listening";
      const energy = state === "speaking" ? rnd() : AURA_ENERGY_FLOOR;
      shaderTime += dt;
      const target = getAuraUniformTarget(state, energy, shaderTime);
      const ease = 1 - Math.exp(-dt / 0.46);
      old.speed = lerp(old.speed, target.speed, ease);
      old.scale = lerp(old.scale, target.scale, ease);
      const ampEase =
        1 - Math.exp(-dt / (target.amplitude > old.amplitude ? 0.05 : 0.18));
      old.amplitude = lerp(old.amplitude, target.amplitude, ampEase);
      old.frequency = lerp(old.frequency, target.frequency, ease);
      old.brightness = lerp(old.brightness, target.brightness, ease);
      phaseTime += dt * (0.3 + old.speed * 0.03);
      const f = a.step(dt, state, energy);
      expect(f.speed).toBe(old.speed);
      expect(f.scale).toBe(old.scale);
      expect(f.amplitude).toBe(old.amplitude);
      expect(f.frequency).toBe(old.frequency);
      expect(f.brightness).toBe(old.brightness);
      expect(f.phase).toBe(phaseTime);
      expect(f.settle).toBe(0);
      expect(f.focus).toBe(0);
      expect(f.crest).toBe(0);
      expect(f.prism).toBe(0);
    }
  });

  it("the window of light shows only while she speaks, and eases in and out", () => {
    const a = createAuraAnimator("listening", 0, POLISHED);
    for (let i = 0; i < 60; i += 1) a.step(1 / 60, "listening", 0);
    expect(a.frame.focus).toBe(0);
    a.step(1 / 60, "speaking", 0.5);
    expect(a.frame.focus).toBeGreaterThan(0);
    expect(a.frame.focus).toBeLessThan(0.1);
    for (let i = 0; i < 180; i += 1) a.step(1 / 60, "speaking", 0.5);
    expect(a.frame.focus).toBeGreaterThan(0.95);
    for (let i = 0; i < 180; i += 1) a.step(1 / 60, "listening", 0);
    expect(a.frame.focus).toBeLessThan(0.05);
  });

  it("with the settle, the crests subside slowly after speech ends — and still quickly between words", () => {
    const run = (opts: TideOptions, after: AgentAuraState) => {
      const a = createAuraAnimator("listening", 0, opts);
      for (let i = 0; i < 120; i += 1) a.step(1 / 60, "speaking", 1);
      const top = a.frame.amplitude;
      a.step(0.3, after, 0);
      return (top - a.frame.amplitude) / top;
    };
    // After the reply: the classic tide has dropped most of the way in 0.3 s,
    // the settled one well under half.
    expect(run(TIDE_CLASSIC, "listening")).toBeGreaterThan(0.65);
    expect(run(POLISHED, "listening")).toBeLessThan(0.4);
    // A pause between words is still the quick release — the rhythm reads.
    expect(run(POLISHED, "speaking")).toBeCloseTo(
      run(TIDE_CLASSIC, "speaking"),
      9,
    );
  });

  it("carries the crest glint and the prism as set", () => {
    const a = createAuraAnimator("listening", 0, POLISHED);
    a.step(1 / 60, "speaking", 0.4);
    expect(a.frame.crest).toBe(1);
    expect(a.frame.prism).toBe(0.35);
  });
});

describe("the smooth breath (TideOptions.smoothBreath)", () => {
  it("breathes once per 2.8 s over the classic ranges, with no corner", () => {
    const at = (t: number) => getAuraUniformTarget("listening", 0, t, POLISHED);
    expect(at(0).amplitude).toBeCloseTo(0.112, 6);
    expect(at(1.4).amplitude).toBeCloseTo(0.192, 6);
    expect(at(2.8).amplitude).toBeCloseTo(0.112, 6);
    expect(at(0).brightness).toBeCloseTo(1.5, 6);
    expect(at(1.4).brightness).toBeCloseTo(2.0, 6);
    // The classic brightness flickers on a 0.7 s triangle; the smooth one
    // moves on the same breath as the crest.
    const slope = (t: number) =>
      (at(t + 0.01).amplitude - at(t).amplitude) / 0.01;
    expect(Math.abs(slope(1.395))).toBeLessThan(0.01); // flat at the top
  });
  it("does not touch speaking or disconnected", () => {
    for (const s of ["speaking", "disconnected"] as const) {
      expect(getAuraUniformTarget(s, 0.6, 1.1, POLISHED)).toEqual(
        getAuraUniformTarget(s, 0.6, 1.1),
      );
    }
  });
});

describe("stepSettle — the calm after speech", () => {
  const run = (s: SettleState, speaking: boolean, seconds: number) => {
    let v = 0;
    for (let t = 0; t < seconds; t += 1 / 60)
      v = stepSettle(s, speaking, 1 / 60);
    return v;
  };
  it("is nothing while she speaks — not even as speech starts", () => {
    const s = initialSettle();
    for (let t = 0; t < 5; t += 1 / 60) {
      expect(stepSettle(s, true, 1 / 60)).toBe(0);
    }
  });
  it("rises after a stretch of speech ends, then fades back to nothing", () => {
    const s = initialSettle();
    run(s, true, 4);
    const soon = run(s, false, 0.4);
    expect(soon).toBeGreaterThan(0.5);
    expect(run(s, false, 1.6)).toBeLessThan(soon);
    expect(run(s, false, 3)).toBeLessThan(0.03);
  });
  it("a moment of speech leaves only a small one", () => {
    const long = initialSettle();
    run(long, true, 4);
    const brief = initialSettle();
    run(brief, true, 0.15);
    expect(run(brief, false, 0.4)).toBeLessThan(run(long, false, 0.4) / 2);
  });
  it("speech resuming mid-settle eases it away, never snaps it", () => {
    const s = initialSettle();
    run(s, true, 4);
    const before = run(s, false, 0.5);
    const next = stepSettle(s, true, 1 / 60);
    expect(before - next).toBeLessThan(before * 0.25);
    expect(run(s, true, 0.6)).toBeLessThan(0.01);
  });
  it("is frame-rate independent", () => {
    const a = initialSettle();
    const b = initialSettle();
    for (let i = 0; i < 120; i += 1) stepSettle(a, i < 60, 1 / 60);
    for (let i = 0; i < 240; i += 1) stepSettle(b, i < 120, 1 / 120);
    expect(a.after).toBeCloseTo(b.after, 6);
    expect(a.value).toBeCloseTo(b.value, 2);
  });
});

describe("deriveAuraState", () => {
  it("no session → disconnected", () => {
    expect(deriveAuraState({ sessionId: null, status: "idle" })).toBe(
      "disconnected",
    );
    expect(deriveAuraState({ sessionId: null, status: "speaking" })).toBe(
      "disconnected",
    );
  });
  it("active session, speaking → speaking", () => {
    expect(deriveAuraState({ sessionId: "s", status: "speaking" })).toBe(
      "speaking",
    );
  });
  it("active session, idle/thinking → listening", () => {
    expect(deriveAuraState({ sessionId: "s", status: "idle" })).toBe(
      "listening",
    );
    expect(deriveAuraState({ sessionId: "s", status: "thinking" })).toBe(
      "listening",
    );
  });
});

describe("displayAuraState", () => {
  it("a playing voice clip forces speaking (audio-only cue, e.g. easter egg)", () => {
    // idle session, but a clip is playing → speaking.
    expect(displayAuraState({ sessionId: "s", status: "idle" }, true)).toBe(
      "speaking",
    );
  });
  it("no voice + idle → listening (unchanged)", () => {
    expect(displayAuraState({ sessionId: "s", status: "idle" }, false)).toBe(
      "listening",
    );
  });
  it("text-driven speaking stays speaking regardless of voice", () => {
    expect(
      displayAuraState({ sessionId: "s", status: "speaking" }, false),
    ).toBe("speaking");
  });
  it("no session stays disconnected even while a clip plays", () => {
    expect(displayAuraState({ sessionId: null, status: "idle" }, true)).toBe(
      "disconnected",
    );
  });
});

describe("resolveAura", () => {
  it("normal motion passes state + energy through", () => {
    expect(resolveAura("speaking", false, 0.8)).toEqual({
      state: "speaking",
      energy: 0.8,
    });
  });
  it("reduced motion pins listening + floors energy (no flutter)", () => {
    const r = resolveAura("speaking", true, 0.9);
    expect(r.state).toBe("listening");
    expect(r.energy).toBe(AURA_ENERGY_FLOOR);
  });
});

describe("getAuraUniformTarget", () => {
  it("speaking amplitude grows with energy", () => {
    const lo = getAuraUniformTarget("speaking", 0.1, 0);
    const hi = getAuraUniformTarget("speaking", 0.9, 0);
    expect(hi.amplitude).toBeGreaterThan(lo.amplitude);
  });
  it("listening brightness stays within its pulse range", () => {
    const u = getAuraUniformTarget("listening", 0, 0.35);
    expect(u.brightness).toBeGreaterThanOrEqual(1.5);
    expect(u.brightness).toBeLessThanOrEqual(2.0);
  });
  it("disconnected is calm (low speed)", () => {
    expect(getAuraUniformTarget("disconnected", 0, 0).speed).toBeLessThan(
      getAuraUniformTarget("speaking", 0.5, 0).speed,
    );
  });

  // Tide-wave mapping (glass-wave direction, 2026-07-05): amplitude IS the
  // crest height, so the resting states must stay near-flat.
  it("disconnected rests as a nearly flat waterline", () => {
    expect(getAuraUniformTarget("disconnected", 0, 0).amplitude).toBeLessThan(
      0.1,
    );
  });
  it("listening amplitude breathes within the hairline band", () => {
    const flat = getAuraUniformTarget("listening", 0, 0).amplitude; // pulse=0
    const peak = getAuraUniformTarget("listening", 0, 0.8).amplitude; // pulse=1
    expect(flat).toBeCloseTo(0.112, 3);
    expect(peak).toBeCloseTo(0.192, 3);
  });
  it("speaking crest height spans well above the listening band", () => {
    expect(getAuraUniformTarget("speaking", 1, 0).amplitude).toBeGreaterThan(
      1.0,
    );
  });
});
