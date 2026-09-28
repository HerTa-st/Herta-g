/**
 * The opening probe (2026-09-28, ADR 0068 §19). The opening draws on a worker
 * from a glyph sheet the app keeps between launches (§15–§18), all of it
 * verified only on Windows until this probe ran on the macOS and Linux
 * runners. It LAUNCHES the app itself, so it can attach before the opening
 * starts, and checks one launch:
 *
 *   - the four launch marks arrive (app painted, opening painted, revealed,
 *     interactive) — the opening played to the end;
 *   - the opening-painted mark says the WORKER drew it, and the sheet's
 *     origin is the expected one: `drawn` on a fresh profile, `kept` on the
 *     launch after (`any` accepts either, `none` expects text);
 *   - every frame of the opening holds the figure: the page is screencast
 *     from the first frame to the end, each frame dated by its own swap
 *     time, its ink (pixels far from the background's luminance) measured
 *     in the page after the opening. From the frame where the figure has
 *     developed through the first quarter of the dissolve, each must keep a
 *     quarter of the hold's ink. A frame without is a flash; up to five are
 *     saved as opening-<label>-blank-<ms>.jpg. The longest stretch without
 *     a frame is reported, not judged;
 *   - no uncaught exception in the page.
 *
 *   node opening-probe.mjs <outDir> <label> <drawn|kept|any|none> -- <command…>
 *
 * The command is the app (or `xvfb-run … <AppImage>`); the debug-port switch
 * is appended to it. Prints `OPENING PROBE <label>: PASS` or `FAIL (…)`,
 * writes opening-<label>.json and .jpg, exits 1 on FAIL. The app is closed
 * (SIGTERM to its process group, then SIGKILL) and its port waited out
 * before the probe returns, so the next launch is not refused by the
 * single-instance lock.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dash = process.argv.indexOf("--");
const [OUT, LABEL, EXPECT] = process.argv.slice(2, dash < 0 ? undefined : dash);
const COMMAND = dash < 0 ? [] : process.argv.slice(dash + 1);
if (!OUT || !LABEL || !EXPECT || COMMAND.length === 0) {
  throw new Error(
    "usage: opening-probe.mjs <outDir> <label> <drawn|kept|any|none> -- <command…>",
  );
}
mkdirSync(OUT, { recursive: true });
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) {
        this.handlers.get(msg.method)?.(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`);
    return r.result?.value;
  }
}

/**
 * The page's screencast frames until `done()` or `ms`: { how, at, data },
 * `at` in the page's clock — the frame's own swap time. The FIRST frame is
 * dropped: it can be stale (on Linux at scale 2 it was a flat fill without
 * even the window controls, which exist from React's first paint — the trap
 * opening-flash.mjs met in a late-started trace, ADR 0068 §18). A covered
 * window gets no screencast frames; after 1.5 s of none, one plain capture
 * stands in, dated by when it RETURNED (its frame is no later).
 */
async function recordScreencast(cdp, origin, done, ms) {
  const got = [];
  let seen = 0;
  cdp.on("Page.screencastFrame", (p) => {
    cdp
      .send("Page.screencastFrameAck", { sessionId: p.sessionId })
      .catch(() => undefined);
    seen += 1;
    const swapped = p.metadata?.timestamp;
    if (seen === 1 || typeof swapped !== "number") return;
    got.push({
      how: "screencast",
      at: Math.round(swapped * 1000 - origin),
      data: p.data,
    });
  });
  // At CSS size: a scale-2 frame is four times the pixels, and on a
  // software-rendered surface (Linux under Xvfb) the full-size screencast
  // delivered ONE frame in the whole opening (2026-09-28). Ink is a ratio,
  // so it reads the same at either size.
  const view = await cdp.eval("[window.innerWidth, window.innerHeight]");
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: view[0],
    maxHeight: view[1],
  });
  const started = Date.now();
  let captured = false;
  while (Date.now() - started < ms && !(await done())) {
    if (!captured && seen === 0 && Date.now() - started > 1500) {
      captured = true;
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
      });
      const at = await cdp.eval("performance.now()");
      got.push({ how: "capture", at: Math.round(at), data: shot.data });
    }
    await sleep(40);
  }
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  cdp.on("Page.screencastFrame", () => undefined);
  return got;
}

async function portAnswers() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

const log = openSync(join(OUT, `opening-${LABEL}-boot.log`), "w");
const [cmd, ...args] = COMMAND;
const child = spawn(cmd, [...args, `--remote-debugging-port=${PORT}`], {
  detached: true,
  stdio: ["ignore", log, log],
});
let exited = false;
child.on("exit", () => {
  exited = true;
});

async function close() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      if (process.platform === "win32") {
        // No process groups here: the tree goes by pid (a local run).
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      /* the group is already gone */
    }
    for (let i = 0; i < 50 && (!exited || (await portAnswers())); i += 1) {
      await sleep(200);
    }
    if (exited && !(await portAnswers())) break;
  }
  await sleep(1500);
}

const report = { label: LABEL, expect: EXPECT, command: COMMAND };
const problems = [];
const errors = [];
/** { how, at, data, screen } per recorded frame. */
let frames = [];
try {
  let ws = null;
  for (let i = 0; i < 1800 && ws === null && !exited; i += 1) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      ws =
        list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"))
          ?.webSocketDebuggerUrl ?? null;
    } catch {
      /* not listening yet */
    }
    if (ws === null) await sleep(50);
  }
  if (ws === null)
    throw new Error("the app never opened a page on the debug port");
  const cdp = new Cdp(ws);
  await cdp.ready;
  cdp.on("Runtime.exceptionThrown", (p) =>
    errors.push(
      p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
    ),
  );
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const hasMark = (name) =>
    cdp
      .eval(`performance.getEntriesByName('herta:launch:${name}').length > 0`)
      .catch(() => false);
  const waitMark = async (name, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await hasMark(name)) return true;
      await sleep(40);
    }
    return false;
  };

  if (await waitMark("opening-painted", 60_000)) {
    // Every frame of the opening, dated by its own swap time in the page's
    // clock (the marks'), until the opening is over. One screenshot was not
    // enough (2026-09-28, Linux at scale 2): a starved window answered with
    // the connect screen, a capture call on a large software surface took
    // 2.1 s, and one frame just into the dissolve had no glyphs — whether
    // the figure vanished or the capture missed it, one frame cannot say.
    const origin = await cdp.eval("performance.timeOrigin");
    frames = await recordScreencast(
      cdp,
      origin,
      () => hasMark("interactive"),
      30_000,
    );
  } else {
    problems.push("no opening-painted mark within 60 s");
  }
  if (!(await waitMark("interactive", 30_000))) {
    problems.push("no interactive mark: the opening never finished");
  }
  // Measured in the page, after the opening: pixels in the figure's band
  // far from the background's luminance (the top-left corner), whatever
  // the theme.
  await cdp.eval(`window.__openingInk = async (b64) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const bgData = g.getImageData(Math.floor(W * 0.03), Math.floor(H * 0.1), Math.max(1, Math.floor(W * 0.1)), Math.max(1, Math.floor(H * 0.1))).data;
    let bg = 0;
    for (let i = 0; i < bgData.length; i += 4) bg += lum(bgData, i);
    bg /= bgData.length / 4;
    const d = g.getImageData(Math.floor(W * 0.3), Math.floor(H * 0.1), Math.floor(W * 0.4), Math.floor(H * 0.8)).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(lum(d, i) - bg) > 60) ink += 1;
    return { width: W, height: H, background: Math.round(bg), inkRatio: ink / (d.length / 4) };
  }; true`);
  for (const f of frames) {
    f.screen = await cdp
      .eval(`window.__openingInk('${f.data}')`)
      .catch(() => null);
  }
  report.dpr = await cdp.eval("window.devicePixelRatio").catch(() => null);
  report.theme = await cdp
    .eval("document.documentElement.dataset.theme ?? 'light'")
    .catch(() => null);
  report.marks = await cdp.eval(
    `performance.getEntriesByType('mark').filter((m) => m.name.startsWith('herta:launch:')).map((m) => ({ name: m.name.slice(13), at: Math.round(m.startTime), detail: m.detail ?? null }))`,
  );
  // Let the sheet worker finish storing the sheet for the next launch.
  await sleep(1500);
  cdp.ws.close();
} catch (error) {
  problems.push(String(error?.message ?? error));
} finally {
  await close();
}

const marks = new Map((report.marks ?? []).map((m) => [m.name, m]));
for (const name of [
  "app-painted",
  "opening-painted",
  "revealed",
  "interactive",
]) {
  if (!marks.has(name)) problems.push(`missing mark ${name}`);
}
const how = marks.get("opening-painted")?.detail ?? null;
report.drawn = how;
if (how !== null) {
  if (how.host !== "worker")
    problems.push(`drawn on ${how.host}, not on the worker`);
  if (EXPECT !== "any" && how.sheet !== EXPECT) {
    problems.push(`sheet ${how.sheet}, expected ${EXPECT}`);
  }
  if (EXPECT === "any" && how.sheet === "none")
    problems.push("no glyph sheet used");
} else if (marks.has("opening-painted")) {
  problems.push("the opening-painted mark carries no detail");
}
// The frames judged: from the first whose figure has developed (half the
// hold's ink — the figure fades in over ~0.5 s, and those frames are not
// flashes) through the first quarter of the dissolve (still near opaque).
// Each must keep a quarter of the hold's ink: a frame without is a flash,
// the class the owner saw on Windows (ADR 0068 §18). Past that the figure
// fades and the connect screen shows through, so no later frame says
// anything.
const inkOf = (f) => f.screen?.inkRatio ?? 0;
const painted = marks.get("opening-painted")?.at;
const revealed = marks.get("revealed")?.at;
const ended = marks.get("interactive")?.at;
report.frames = frames.map((f) => ({
  how: f.how,
  at: f.at,
  ink: Number(inkOf(f).toFixed(4)),
}));
let judged = [];
if (painted !== undefined && revealed !== undefined && ended !== undefined) {
  const hold = frames.filter((f) => f.at > painted && f.at <= revealed);
  const level = hold.reduce((m, f) => Math.max(m, inkOf(f)), 0);
  const start = hold.find((f) => inkOf(f) >= level / 2);
  const to = Math.round(revealed + (ended - revealed) * 0.25);
  if (level < 0.003 || start === undefined) {
    problems.push(
      `no glyphs in any frame of the opening (${hold.length} frames before the reveal, best ink ${level.toFixed(4)})`,
    );
  } else {
    judged = frames.filter((f) => f.at >= start.at && f.at <= to);
    const blank = judged.filter((f) => inkOf(f) < level / 4);
    report.judged = {
      from: start.at,
      to,
      level: Number(level.toFixed(4)),
      frames: judged.length,
      blank: blank.map((f) => f.at),
    };
    if (blank.length > 0) {
      problems.push(
        `${blank.length} of ${judged.length} frames of the opening lost the figure (at ${blank.map((f) => f.at).join(", ")} ms)`,
      );
    }
    for (const f of blank.slice(0, 5)) {
      writeFileSync(
        join(OUT, `opening-${LABEL}-blank-${f.at}.jpg`),
        Buffer.from(f.data, "base64"),
      );
    }
  }
  // The longest stretch without a frame while the figure shows: the
  // reveal's workbench mount has been seen to hold the screen ~0.2 s.
  let gap = { ms: 0, after: null };
  for (let i = 1; i < judged.length; i += 1) {
    const ms = judged[i].at - judged[i - 1].at;
    if (ms > gap.ms) gap = { ms, after: judged[i - 1].at };
  }
  report.longestGap = gap;
}
// The picture to look at: the judged frame nearest 0.7 s in (the hold).
const shown = [...judged].sort(
  (a, b) =>
    Math.abs(a.at - (painted ?? 0) - 700) -
    Math.abs(b.at - (painted ?? 0) - 700),
)[0];
if (shown !== undefined) {
  writeFileSync(
    join(OUT, `opening-${LABEL}.jpg`),
    Buffer.from(shown.data, "base64"),
  );
  report.screen = { at: shown.at, how: shown.how, ...shown.screen };
}
if (errors.length > 0) problems.push(`page exceptions: ${errors.join(" | ")}`);
report.errors = errors;
report.problems = problems;
writeFileSync(
  join(OUT, `opening-${LABEL}.json`),
  JSON.stringify(report, null, 2),
);

const at = (name) => marks.get(name)?.at ?? "–";
console.log(
  `opening ${LABEL}: dpr ${report.dpr} · theme ${report.theme} · drawn on ${how?.host ?? "?"} from sheet ${how?.sheet ?? "?"} · marks painted ${at("app-painted")} / opening ${at("opening-painted")} / revealed ${at("revealed")} / interactive ${at("interactive")} ms · frames ${frames.length} recorded, ${judged.length} judged, ${report.judged?.blank.length ?? "–"} blank, longest gap ${report.longestGap?.ms ?? "–"} ms · ink at ${report.screen?.at ?? "–"} ms ${report.screen?.inkRatio?.toFixed(4) ?? "–"}`,
);
if (problems.length === 0) {
  console.log(`OPENING PROBE ${LABEL}: PASS`);
} else {
  console.log(`OPENING PROBE ${LABEL}: FAIL (${problems.join("; ")})`);
  process.exitCode = 1;
}
