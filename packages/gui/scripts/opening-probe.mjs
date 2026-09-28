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
 *   - a screenshot 0.7 s into the opening holds glyphs: pixels far from the
 *     background's luminance, measured in the page from the capture — and
 *     the capture ended before the opening did (a starved window answers
 *     with a later frame);
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
    // Into the hold: the figure developed, the veil frosted.
    await sleep(700);
    // When the capture was taken, in the page's own clock (the marks'): a
    // window that gets no frames answers with the first frame it paints,
    // which can be the connect screen after the opening — and the connect
    // button alone passes the ink check (the first Linux run at scale 2,
    // 2026-09-28). A capture that ends after the opening proves nothing.
    const from = await cdp.eval("performance.now()");
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 85,
    });
    const to = await cdp.eval("performance.now()");
    report.capture = { from: Math.round(from), to: Math.round(to) };
    writeFileSync(
      join(OUT, `opening-${LABEL}.jpg`),
      Buffer.from(shot.data, "base64"),
    );
    // Measured in the page: pixels in the figure's band far from the
    // background's luminance (the top-left corner), whatever the theme.
    report.screen = await cdp.eval(`(async () => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,${shot.data}';
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
    })()`);
  } else {
    problems.push("no opening-painted mark within 60 s");
  }
  if (!(await waitMark("interactive", 30_000))) {
    problems.push("no interactive mark: the opening never finished");
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
const ended = marks.get("interactive")?.at;
if (report.capture && ended !== undefined && report.capture.to > ended) {
  problems.push(
    `the screenshot landed after the opening (taken ${report.capture.from}–${report.capture.to} ms, interactive at ${ended} ms)`,
  );
} else if (report.screen && report.screen.inkRatio < 0.003) {
  problems.push(
    `no glyphs on screen (ink ${report.screen.inkRatio.toFixed(4)})`,
  );
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
  `opening ${LABEL}: dpr ${report.dpr} · theme ${report.theme} · drawn on ${how?.host ?? "?"} from sheet ${how?.sheet ?? "?"} · marks painted ${at("app-painted")} / opening ${at("opening-painted")} / revealed ${at("revealed")} / interactive ${at("interactive")} ms · shot ${report.capture ? `${report.capture.from}–${report.capture.to}` : "–"} ms · ink ${report.screen ? report.screen.inkRatio.toFixed(4) : "–"}`,
);
if (problems.length === 0) {
  console.log(`OPENING PROBE ${LABEL}: PASS`);
} else {
  console.log(`OPENING PROBE ${LABEL}: FAIL (${problems.join("; ")})`);
  process.exitCode = 1;
}
