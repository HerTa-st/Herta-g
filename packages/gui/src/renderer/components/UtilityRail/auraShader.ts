export const AURA_SHADER_SOURCE = `
precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uBlur;
uniform float uScale;
uniform float uShape;
uniform float uFrequency;
uniform float uAmplitude;
uniform float uBloom;
uniform float uMix;
uniform float uSpacing;
uniform float uColorShift;
uniform float uVariance;
uniform float uSmoothing;
uniform float uMode;
uniform vec3 uColor;
/* Glass-sheet base value (night mode 2026-07-13): the sheets were hardcoded
   dark (0.16) — "translucent dark sheets that darken the white backdrop" —
   which vanish on the dark composer glass. The base now arrives from CSS
   (--aura-base): 0.16 light, ~0.84 dark, so dark mode draws LIGHT sheets
   that lift the dark backdrop instead. */
uniform float uBase;
/* The tide's polish (2026-09-30, after a study of the Siri ribbon — its
   motion lessons, not its look). Every one of these at 0 draws the tide
   exactly as before; aura-engine's TideOptions decides which are on.
   uSettle   0..1  the calm after speech: the sheets soften and fade a
                   little while the crests subside, instead of snapping flat
   uFocus    0..1  a window of light drifting along the band while speaking
   uCrest    0..1  the sheets standing highest hold more glass and light, so
                   each word's crest reads above the band
   uPrism    0..1  the glass leans toward its sheets' own tints, uPrismA at
                   the first sheet → uPrismB at the last (the backdrop's
                   jade → blue; CSS --aura-prism-a/-b)
   uClock    s     wall time, for the window's slow drift */
uniform float uSettle;
uniform float uFocus;
uniform float uCrest;
uniform float uPrism;
uniform float uClock;
uniform vec3 uPrismA;
uniform vec3 uPrismB;

const float TAU = 6.28318530718;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.11369, 0.13787));
  q += dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * q.z);
}

mat2 rot(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

vec2 warpField(vec2 p, float t, float phase) {
  mat2 frame = rot(0.28 + sin(phase) * 0.14);
  mat2 turn = rot(0.92);
  float freq = mix(2.0, 11.5, clamp(uFrequency, 0.0, 1.35));
  float amp = uAmplitude * 0.78;

  for (int i = 0; i < 4; i++) {
    vec2 rp = frame * p;
    vec2 wave = sin(rp * freq + vec2(phase + t * 0.58, phase * 0.73 - t * 0.43));
    p += frame[0] * wave * (amp / max(freq, 0.001)) * 0.62;
    p += frame[1] * wave.yx * (amp / max(freq, 0.001)) * 0.18;
    frame = turn * frame;
    freq *= 1.42;
    amp *= mix(0.82, 1.05, uVariance);
  }

  return p;
}

// Tide-wave curve (glass-wave direction, 2026-07-05): three traveling sines
// under a center-weighted bell. Crest height rides uAmplitude, so the wave
// collapses to a hairline at rest and punches per word while speaking.
// Geometry study: reference_UX_design/glass-wave-study/.
float waveCurve(float x, float t, float phase, float k1) {
  float a = sin(x * k1 + t * 1.9 + phase * 2.0);
  float b = sin(x * (k1 * 1.62) - t * 1.3 + phase * 3.1) * 0.55;
  float c = sin(x * (k1 * 0.43) + t * 0.7 - phase * 1.2) * 0.35;
  return (a + b + c) / 1.9;
}

float waveY(float x, float t, float phase) {
  // From the glass-wave study material — full per-layer phase decorrelation
  // is what makes the band read as soft frosted glass (coherent layers
  // collapse into scratchy strands).
  float env = exp(-x * x * 10.0);
  float layerAmp = 0.6 + 0.4 * sin(phase * 2.3 + t * 0.8);
  float k1 = mix(14.0, 34.0, clamp(uFrequency, 0.0, 1.35) / 1.35);
  // 0.22 crest scale (study used 0.16): the composer edge clips the band's
  // lower half, so the visible upper half gets extra height. Max-energy
  // tops still clear the input text zone.
  return waveCurve(x, t, phase, k1) * env * layerAmp * uAmplitude * 0.22;
}

// Unsigned distance to the base shape. q is the glass-warped point; the tide
// branch blends back toward the raw point p so the waterline keeps its wave
// structure and the warp only adds fold turbulence. The crest out-parameter
// is how high this sheet's wave stands at the point, 0 (the waterline) .. 1
// (the tallest crest the amplitude allows); the other shapes have none.
float shapeDistance(vec2 q, vec2 p, float t, float phase, out float crest) {
  crest = 0.0;
  if (uShape > 2.5) {
    vec2 w = mix(p, q, 0.25);
    // The study material's two-sided frosted band, its centerline pinned at
    // the composer's bottom edge — the half below the edge is clipped by
    // the canvas, so only the crests above remain visible. This keeps the
    // exact material.html look (a one-sided max() variant destroyed it:
    // decorrelated layers never overlap above a shared baseline).
    float wy = waveY(w.x, t, phase);
    crest = wy / max(uAmplitude * 0.22, 1e-3);
    float y = wy - 0.47;
    return abs(w.y - y);
  }

  if (uShape > 1.5) {
    vec2 a = vec2(-uScale * 1.85, 0.0);
    vec2 b = vec2(uScale * 1.85, 0.0);
    vec2 pa = q - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return abs(length(pa - ba * h) - uScale * 0.1);
  }

  return abs(length(q) - uScale);
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = uv - 0.5;
  float t = iTime;

  // The tide lives along the bottom edge; the rows above everything it can
  // reach return at once (2026-09-30). Measured on the real shader over 160
  // phases per amplitude, the topmost lit row stands at p.y ≈ −0.4625 +
  // 0.227·uAmplitude (−0.448 at rest, −0.156 at the loudest speech); this
  // bound keeps ≥ 0.05 of canvas height above that, and the settle's softer
  // sheets reach further. Before it, every pixel of the canvas paid the
  // full 30-sheet march — ~88 % of them for nothing at rest. A harness
  // compared it against the same shader without the cut, every upgrade on,
  // 480 frames: no pixel differs.
  if (uShape > 2.5 && p.y > -0.41 + 0.25 * uAmplitude + 0.2 * uSettle) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float spacing = mix(1.15, TAU, clamp(uSpacing, 0.0, 1.0));

  // density = translucent glass coverage; spec = sharp catch-light along folds
  float density = 0.0;
  float spec = 0.0;
  // The glass's hue, weighted by each sheet's share of it (uPrism).
  vec3 hue = vec3(0.0);

  const int STEPS = 30;
  vec2 previous = warpField(p, t, -1.0 / float(STEPS));

  for (int i = 0; i < STEPS; i++) {
    float n = float(i) / float(STEPS - 1);
    float phase = n * spacing;
    vec2 q = warpField(p, t, phase);
    float crest;
    float d = shapeDistance(q, p, t, phase, crest);
    float travel = distance(q, previous);
    previous = q;

    float dynamicSoftness = max(exp2(travel * 2.4) - 1.0, 0.001);
    float blur = (uBlur * 0.028 + dynamicSoftness * (0.24 + uSmoothing * 0.2))
      * (1.0 + 1.5 * uSettle);
    float edge = 1.0 - smoothstep(0.0, blur, d);
    float veil = 1.0 - smoothstep(blur * 0.45, blur * (1.65 + uAmplitude * 0.24), d);
    float sheet = veil * (0.42 + 0.58 * smoothstep(0.0, 0.85, sin(n * TAU + t * 0.18) * 0.5 + 0.5));
    float fade = smoothstep(0.0, 0.08, n) * (1.0 - smoothstep(0.95, 1.0, n));

    // A sheet standing high holds more glass and catches more light than one
    // near the waterline, so each word's crest reads above the band.
    float high = smoothstep(0.2, 1.0, crest);
    float body = (sheet * 0.05 + edge * 0.05) * fade * (1.0 + uCrest * 1.2 * high);
    density += body;
    spec += edge * edge * 0.05 * fade * (1.0 + uCrest * 2.0 * high);
    // Each sheet's own tint, jade at the first to blue at the last: the
    // sheets are out of phase, so the tints interleave through the band.
    hue += body * mix(uPrismA, uPrismB, n);
  }

  hue /= max(density, 1e-5);
  density /= float(STEPS) * 0.11;
  spec /= float(STEPS) * 0.11;

  // Outline shapes float inside a vignette. The tide line hugs the
  // composer's bottom edge; its ends dissolve over the outer ~12% of each
  // side, reaching zero AT the edge — a hard edge-to-edge line terminated
  // abruptly against the composer's light border (user 2026-07-06).
  float radialFade = uShape > 2.5
    ? smoothstep(0.50, 0.38, abs(p.x))
    : smoothstep(0.5, 0.24, length(p));
  // Density gain for the composer wave: the wide, short canvas spreads the
  // ink thinner than the study panels.
  float covMul = uShape > 2.5 ? 1.25 : 1.0;
  float coverage = clamp(density * covMul, 0.0, 1.0) * radialFade;
  spec = clamp(spec * covMul, 0.0, 1.0) * radialFade;

  // A window of light drifting along the band while she speaks: the glass
  // it passes over holds more light, the rest of the band dims a little.
  if (uFocus > 0.0) {
    float at = (p.x - 0.2 * sin(0.19 * uClock)) / 0.24;
    float win = exp(-0.5 * at * at);
    coverage *= mix(1.0, 0.5 + 0.8 * win, uFocus);
    spec *= mix(1.0, 0.4 + 1.4 * win, uFocus);
  }

  // Tinted grayscale glass: translucent sheets against the backdrop — dark
  // sheets on the light theme, light sheets on the dark one (uBase).
  // uColor lightly tints the glass; the default keeps it neutral frosted.
  // uPrism leans the glass toward its sheets' own tints.
  vec3 glassTint = mix(vec3(uBase), clamp(uColor, 0.0, 1.0), 0.22);
  glassTint = mix(glassTint, clamp(hue, 0.0, 1.0), uPrism);
  vec3 color = mix(glassTint, vec3(0.97), spec * 0.7);

  float noise = (hash(fragCoord + t) - 0.5) / 255.0;
  color += noise;

  float opacity = clamp(coverage * (0.82 + uMix * 0.26), 0.0, 0.92)
    * (1.0 - 0.3 * uSettle);
  float finalAlpha = clamp(max(opacity, spec * 0.8), 0.0, 0.94);

  gl_FragColor = vec4(color, finalAlpha);
}
`;
