import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { type BackgroundProcess, isPathInside } from "@herta/core";
import { childProcessEnv } from "../child-env.js";
import { type ShellPaths, shellPathsFor } from "./shell-paths.js";

/**
 * One persistent bash per brief (ADR 0040) — the trained shape's "state is
 * persistent across command calls": cwd, exported variables, functions and
 * background jobs survive from one `bash` call to the next inside a
 * commission, and die with it.
 *
 * Protocol: commands are written to the shell's stdin one at a time, each
 * wrapped in `{ … } </dev/null` (so a command that reads stdin cannot eat
 * the NEXT command) and followed by a marker line carrying the exit code,
 * a cwd-reset flag and `$PWD`. Output (stdout+stderr merged via `exec 2>&1`)
 * is everything before the marker. If the shell has `cd`'d out of the
 * workspace, the wrapper puts it back and says so — the permission
 * classifier reasons about relative paths against the workspace, and that
 * invariant must hold when the next command is classified.
 *
 * Timeout kills the whole process tree and the next call respawns a fresh
 * shell (state lost — the model is told). Registered with the brief's
 * BackgroundHost as an INTERNAL entry, so `stopAll()` at brief end reaps it
 * like any background process without reporting it as one.
 */
export interface ShellRunResult {
  /** Merged stdout+stderr, `\r\n` normalized, marker stripped, capped. */
  output: string;
  /** Total bytes observed before the cap. */
  outputBytes: number;
  capped: boolean;
  /** null on timeout or shell death. */
  exitCode: number | null;
  timedOut: boolean;
  shellExited: boolean;
  durationMs: number;
  /** Native cwd after the command (workspace when reset). */
  cwd: string;
  /** The command left the workspace; the shell was moved back. */
  cwdReset: boolean;
  /** This call spawned a fresh shell (first call, or after a reset). */
  freshShell: boolean;
}

export interface PersistentShellOpts {
  bashPath: string;
  workspaceRoot: string;
  /** Extra environment on top of the inherited one. */
  env?: Record<string, string>;
  /** Capture cap on merged output per command (default 1 MiB). */
  maxOutputBytes?: number;
  /** Each bash this shell starts (a restart after a timeout starts another),
   *  and each one's end — the run's journal records them, so a relaunch
   *  after a crash ends a shell still running (ADR 0071 §1.6). */
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}

/** BackgroundHost id under which the shell registers (internal). */
export const SHELL_BG_ID = "shell";

const DEFAULT_MAX_OUTPUT = 1_048_576;
const KILL_GRACE_MS = 3_000;
/** Every protocol marker's length: `__HERTA_SH_` / `__HERTA_WS_` (11) +
 *  12 hex digits + `__` (2). `onData` keeps one less than this as its tail. */
const MARKER_LEN = 25;
const markerFor = (kind: "SH" | "WS"): string =>
  `__HERTA_${kind}_${randomBytes(6).toString("hex")}__`;
/** How long `taskkill /T` may take to fell the shell's process tree. */
const TASKKILL_TIMEOUT_MS = 15_000;

interface Waiter {
  marker: string;
  resolve: (r: Omit<ShellRunResult, "durationMs" | "freshShell">) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
  /** Bytes dropped from the FRONT while bounding a chatty command. */
  dropped: number;
  /** The shell process serving this command. */
  child: ChildProcess;
}

export class PersistentShell implements BackgroundProcess {
  readonly id = SHELL_BG_ID;
  readonly internal = true;
  readonly argv: readonly string[];
  readonly paths: ShellPaths;
  /** The shell's own spelling of the workspace (what `pwd` prints there). */
  private shellWs: string | null = null;
  /** Set while a spawned shell still owes its workspace line. */
  private wsMarker: string | null = null;
  private child: ChildProcess | null = null;
  /** POSIX process groups (= pids) of shells that have exited; a job they
   *  backgrounded may still run in one. See `isRunning`. */
  private readonly exitedGroups = new Set<number>();
  private buf = "";
  /** The last `MARKER_LEN − 1` characters received — what a marker split
   *  across chunks would have left behind. */
  private tail = "";
  /** The waiting command's marker is in `buf`; its line may not be yet. */
  private markerSeen = false;
  private waiter: Waiter | null = null;
  private currentCwd: string;
  private spawnCount = 0;
  private readonly opts: Required<
    Omit<PersistentShellOpts, "env" | "onSpawn" | "onExit">
  > & {
    env: Record<string, string>;
  };
  private readonly onSpawn: ((pid: number) => void) | undefined;
  private readonly onExit: ((pid: number) => void) | undefined;

  constructor(opts: PersistentShellOpts) {
    this.opts = {
      bashPath: opts.bashPath,
      workspaceRoot: resolve(opts.workspaceRoot),
      env: opts.env ?? {},
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    };
    this.onSpawn = opts.onSpawn;
    this.onExit = opts.onExit;
    this.argv = [opts.bashPath];
    this.paths = shellPathsFor(opts.bashPath);
    this.currentCwd = this.opts.workspaceRoot;
  }

  /** Native cwd the next command will start in. */
  get cwd(): string {
    return this.currentCwd;
  }

  /** How the shell spells the workspace (after the first spawn; before it,
   *  the best-effort mapping). */
  get workspaceShellPath(): string {
    return this.shellWs ?? this.paths.toShell(this.opts.workspaceRoot);
  }

  /** The shell process itself — what decides whether the next command needs
   *  a fresh one. */
  private shellAlive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Whether anything this shell started may still be running — the
   * BackgroundHost's question at brief end, not "is the shell up".
   *
   * POSIX (platform review 2026-09-23): the shell runs in its own process
   * group, and a job it backgrounded (`npm run dev > log &`) stays in that
   * group after the SHELL exits — `set -e` plus a failing command, or a
   * plain `exit`. The old answer looked at the shell alone, so `stopAll`
   * skipped the entry and the dev server outlived the brief and the app,
   * holding its port. Exited shells' groups are remembered and count here
   * while any member lives. (A job that made its OWN group — `set -m` — is
   * out of reach of a group kill, as it always was.)
   */
  isRunning(): boolean {
    if (this.shellAlive()) return true;
    this.pruneGroups();
    return this.exitedGroups.size > 0;
  }

  /** Forget every remembered group with no member left, so an id is never
   *  held past its group's end for a later group to reuse. */
  private pruneGroups(): void {
    for (const group of this.exitedGroups) {
      if (!groupAlive(group)) this.exitedGroups.delete(group);
    }
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    // What exited shells left behind first — including when no shell is up.
    for (const group of this.exitedGroups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // already empty
      }
    }
    this.exitedGroups.clear();
    if (child === null) return;
    await killTree(child);
    // Only a waiter still bound to THIS child fails; a fresh shell may
    // already be serving the next command by the time the kill settles.
    if (this.waiter?.child === child)
      this.failWaiter({ shellExited: true, timedOut: false });
  }

  private spawnShell(): void {
    this.spawnCount += 1;
    const isWin = process.platform === "win32";
    const bashDir = dirname(this.opts.bashPath);
    const gitRoot = dirname(bashDir);
    const extraPath = isWin
      ? [
          join(gitRoot, "usr", "bin"),
          join(gitRoot, "bin"),
          join(gitRoot, "mingw64", "bin"),
        ]
      : [];
    const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
    const env: NodeJS.ProcessEnv = {
      // Minus the AppImage launcher's own entries (child-env.ts, 2026-09-23).
      ...childProcessEnv(),
      ...(extraPath.length > 0
        ? { PATH: [...extraPath, inheritedPath].join(isWin ? ";" : ":") }
        : {}),
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      // Never hang on a credential or editor prompt inside a headless shell.
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      PYTHONUNBUFFERED: "1",
      ...this.opts.env,
    };
    const child = spawn(this.opts.bashPath, ["--noprofile", "--norc"], {
      cwd: this.opts.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: own process group so a tree kill takes background jobs too.
      detached: !isWin,
    });
    const spawnedPid = child.pid;
    if (spawnedPid !== undefined) {
      this.onSpawn?.(spawnedPid);
      child.once("exit", () => this.onExit?.(spawnedPid));
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (chunk: string): void => {
      const text = chunk.replace(/\r\n/g, "\n");
      // The newest window — this chunk plus the few characters before it a
      // marker could straddle — is all that can hold a marker that was not
      // there a moment ago.
      const window = this.tail + text;
      this.tail = window.slice(-(MARKER_LEN - 1));
      this.buf += text;
      this.onOutput(window);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Only THIS child's death fails a waiter that belongs to it — after a
    // timeout the old process may exit late, while a fresh shell is already
    // serving the next command.
    child.on("exit", () => {
      // `kill()` lets go of the child before killing its whole group, so
      // only a shell that exited ON ITS OWN is still `this.child` here.
      const ownExit = this.child === child;
      if (ownExit) this.child = null;
      // Its process group outlives it while a backgrounded job runs there
      // (see isRunning). Remembered only if a member is alive right now: a
      // group that is already empty, or one kill() just felled, would be a
      // stale id that a later, unrelated group could take over (review
      // 2026-09-23). POSIX only: Windows has no process groups to kill.
      if (
        ownExit &&
        !isWin &&
        child.pid !== undefined &&
        groupAlive(child.pid)
      ) {
        this.exitedGroups.add(child.pid);
      }
      if (this.waiter?.child === child)
        this.failWaiter({ shellExited: true, timedOut: false });
    });
    child.on("error", () => {
      if (this.child === child) this.child = null;
      if (this.waiter?.child === child)
        this.failWaiter({ shellExited: true, timedOut: false });
    });
    // Merge stderr into stdout in ORDER; remember the workspace spelling.
    //
    // The shell reports that spelling itself, on a line of its own ahead of
    // any command's output (`takeWorkspaceLine`). It used to be asked of a
    // SECOND bash, synchronously — `spawnSync(bash -c pwd)`, 70–120 ms warm
    // on Windows and far more cold — on the first command of every brief,
    // which in the desktop app is the Electron main thread: the paced
    // reveal and the voice IPC stalled behind it (perf audit 2026-09-20).
    // Nothing needed it that early: the prompt's line is built from a shell
    // that never spawns (the mapping), and every other reader asks after a
    // command has run.
    const wsMarker = this.shellWs === null ? markerFor("WS") : null;
    this.wsMarker = wsMarker;
    child.stdin?.write(
      `exec 2>&1\nset +o history\n__herta_ws="$(pwd)"\n${
        wsMarker !== null
          ? `printf '%s:%s\\n' '${wsMarker}' "$__herta_ws"\n`
          : ""
      }`,
    );
    this.child = child;
    this.currentCwd = this.opts.workspaceRoot;
  }

  /** Lift the shell's own `<marker>:<pwd>` line out of the buffer — it is
   *  protocol, never a command's output. Waits for the whole line. */
  private takeWorkspaceLine(): void {
    const marker = this.wsMarker;
    if (marker === null) return;
    const at = this.buf.indexOf(marker);
    if (at === -1) return;
    const end = this.buf.indexOf("\n", at);
    if (end === -1) return;
    const spelled = this.buf.slice(at + marker.length + 1, end);
    if (spelled.startsWith("/")) this.shellWs = spelled;
    this.buf = this.buf.slice(0, at) + this.buf.slice(end + 1);
    this.wsMarker = null;
  }

  private failWaiter(how: { shellExited: boolean; timedOut: boolean }): void {
    const w = this.waiter;
    if (w === null) return;
    this.waiter = null;
    this.markerSeen = false;
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.onAbort !== null && w.signal !== undefined)
      w.signal.removeEventListener("abort", w.onAbort);
    const output = this.buf;
    this.buf = "";
    w.resolve({
      output: output.replace(/\n$/, ""),
      outputBytes: Buffer.byteLength(output, "utf8"),
      capped: false,
      exitCode: null,
      timedOut: how.timedOut,
      shellExited: how.shellExited,
      cwd: this.currentCwd,
      cwdReset: false,
    });
  }

  /**
   * One chunk arrived. The expensive look — `pump`, which searches and cuts
   * the WHOLE buffer — runs only when it can find something: while the
   * shell still owes its workspace line (the first chunks after a spawn), or
   * once the waiting command's marker is in. Otherwise the chunk is only
   * appended and the buffer bounded.
   *
   * It used to `indexOf` the whole buffer on every chunk. `buf += chunk`
   * builds a rope; a search flattens it — a copy of everything received so
   * far, per chunk. A test log of a few megabytes arriving line by line
   * (`PYTHONUNBUFFERED=1` is set above) cost gigabytes of copying, on the
   * desktop app's main thread (perf audit 2026-09-20).
   */
  private onOutput(window: string): void {
    const w = this.waiter;
    if (
      this.wsMarker !== null ||
      this.markerSeen ||
      (w !== null && window.includes(w.marker))
    ) {
      this.pump();
      return;
    }
    this.bound(w);
  }

  /**
   * Bound memory while a chatty command runs (`yes`, a runaway log): keep the
   * last cap-worth plus a margin, count what was dropped. AMORTIZED — the cut
   * happens once the buffer is twice the limit, so its cost (the cut flattens
   * the rope) is paid once per limit's worth of output, not per chunk. What
   * the command finally returns is unchanged: `pump` trims the result to the
   * cap and reports the same totals. Output that arrives while NO command is
   * waiting (a background job's chatter) is bounded too, uncounted — it used
   * to grow without limit until the next command.
   */
  private bound(w: Waiter | null): void {
    const limit = this.opts.maxOutputBytes + 4096;
    if (this.buf.length <= limit * 2) return;
    const drop = this.buf.length - limit;
    if (w !== null)
      w.dropped += Buffer.byteLength(this.buf.slice(0, drop), "utf8");
    this.buf = this.buf.slice(drop);
  }

  private pump(): void {
    this.takeWorkspaceLine();
    const w = this.waiter;
    if (w === null) {
      this.bound(null);
      return;
    }
    const idx = this.buf.indexOf(w.marker);
    if (idx === -1) {
      this.bound(w);
      return;
    }
    // The marker is in: every later chunk must come back here until its
    // line is complete — the window test above no longer sees it.
    this.markerSeen = true;
    const after = this.buf.slice(idx + w.marker.length);
    const m = /^:(-?\d+):([01]):([^\n]*)\n/.exec(after);
    if (m === null) return; // marker line not complete yet
    const rawOutput = this.buf.slice(0, idx).replace(/\n$/, "");
    this.buf = after.slice(m[0].length);
    this.waiter = null;
    this.markerSeen = false;
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.onAbort !== null && w.signal !== undefined)
      w.signal.removeEventListener("abort", w.onAbort);
    const keptBytes = Buffer.byteLength(rawOutput, "utf8");
    const outputBytes = keptBytes + w.dropped;
    const capped = outputBytes > this.opts.maxOutputBytes;
    let output = rawOutput;
    if (keptBytes > this.opts.maxOutputBytes) {
      output = Buffer.from(rawOutput, "utf8")
        .subarray(keptBytes - this.opts.maxOutputBytes)
        .toString("utf8");
    }
    if (w.dropped > 0 || keptBytes > this.opts.maxOutputBytes) {
      output = `[earlier output dropped — ${outputBytes} bytes total, showing the last ${Math.min(keptBytes, this.opts.maxOutputBytes)}]\n${output}`;
    }
    const cwdReset = m[2] === "1";
    const pwdShell = m[3] as string;
    const native = this.paths.toNative(pwdShell);
    this.currentCwd =
      native !== null && isPathInside(this.opts.workspaceRoot, native)
        ? native
        : this.opts.workspaceRoot;
    w.resolve({
      output,
      outputBytes,
      capped,
      exitCode: Number(m[1]),
      timedOut: false,
      shellExited: false,
      cwd: this.currentCwd,
      cwdReset,
    });
  }

  /**
   * Run one command. Serialized: a second call while one is in flight waits
   * for it (the model calls tools one at a time anyway; the loop's parallel
   * batches only ever contain read-only tools, and bash is not one).
   */
  async run(
    command: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ShellRunResult> {
    while (this.waiter !== null) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const t0 = Date.now();
    this.pruneGroups();
    let fresh = false;
    if (!this.shellAlive()) {
      this.spawnShell();
      fresh = true;
    }
    const child = this.child;
    if (child === null || child.stdin === null) {
      return {
        output: "",
        outputBytes: 0,
        capped: false,
        exitCode: null,
        timedOut: false,
        shellExited: true,
        durationMs: Date.now() - t0,
        cwd: this.currentCwd,
        cwdReset: false,
        freshShell: fresh,
      };
    }
    const marker = markerFor("SH");
    const result = await new Promise<
      Omit<ShellRunResult, "durationMs" | "freshShell">
    >((resolvePromise) => {
      const w: Waiter = {
        marker,
        resolve: resolvePromise,
        timer: null,
        onAbort: null,
        signal: opts.signal,
        dropped: 0,
        child,
      };
      w.timer = setTimeout(() => {
        // Timeout: the state is unknowable now — kill and let the next
        // call respawn. Deliver what was captured so far.
        this.waiter = null;
        const output = this.buf;
        this.buf = "";
        void this.kill();
        resolvePromise({
          output: output.replace(/\n$/, ""),
          outputBytes: Buffer.byteLength(output, "utf8"),
          capped: false,
          exitCode: null,
          timedOut: true,
          shellExited: false,
          cwd: this.opts.workspaceRoot,
          cwdReset: false,
        });
      }, opts.timeoutMs);
      if (opts.signal !== undefined) {
        w.onAbort = () => {
          this.waiter = null;
          if (w.timer !== null) clearTimeout(w.timer);
          const output = this.buf;
          this.buf = "";
          void this.kill();
          resolvePromise({
            output: output.replace(/\n$/, ""),
            outputBytes: Buffer.byteLength(output, "utf8"),
            capped: false,
            exitCode: null,
            timedOut: false,
            shellExited: true,
            cwd: this.opts.workspaceRoot,
            cwdReset: false,
          });
        };
        if (opts.signal.aborted) {
          w.onAbort();
          return;
        }
        opts.signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiter = w;
      this.markerSeen = false;
      // Group + stdin from /dev/null: a stdin-reading command cannot eat
      // the protocol line that follows. Heredocs still work — they are
      // read from the script text, not from the command's stdin.
      // `set +e +u` first: a `set -e` the model wrote in an earlier call must
      // not make THIS call's first non-zero status kill the shell (its own
      // `set -e` inside the command still applies within that command).
      const script = [
        "{",
        "set +e; set +u",
        command,
        "} </dev/null",
        `__herta_rc=$?; __herta_reset=0; case "$PWD/" in "$__herta_ws"/*) ;; *) cd "$__herta_ws" && __herta_reset=1 ;; esac; printf '\\n%s:%s:%s:%s\\n' '${marker}' "$__herta_rc" "$__herta_reset" "$PWD"`,
        "",
      ].join("\n");
      child.stdin?.write(script);
    });
    return { ...result, durationMs: Date.now() - t0, freshShell: fresh };
  }

  /** For tests / diagnostics. */
  get spawns(): number {
    return this.spawnCount;
  }
}

/** Whether a POSIX process group still has a member: signal 0 delivers
 *  nothing and only checks. Any error — ESRCH (empty), EPERM (the id now
 *  belongs to someone else's processes) — means there is nothing of ours
 *  left to kill. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const closed = new Promise<void>((r) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      r();
      return;
    }
    child.once("exit", () => r());
    child.once("close", () => r());
  });
  try {
    if (process.platform === "win32") {
      // `taskkill /T` walks the tree — on this machine a scoop shim → git
      // launcher → usr/bin/bash chain, three processes deep — and on a
      // loaded machine took longer than the close grace (the permission
      // lab hung on 2026-09-16 with the whole chain alive after `done.`).
      // Its own timeout is generous; the grace below only bounds the wait
      // for the exit event. AWAITED, never `spawnSync`: this runs at the
      // end of every brief, and blocking here froze the desktop app's main
      // thread — the reveal, the voice IPC, the window — for as long as the
      // tree walk took (perf audit 2026-09-20). The order is unchanged:
      // taskkill settles, then the stdio ends are dropped below.
      await new Promise<void>((settled) => {
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
          (err) => {
            // A string code is a failure to LAUNCH taskkill (a number is
            // its exit status): fell at least the shell itself.
            if (typeof (err as NodeJS.ErrnoException | null)?.code === "string")
              try {
                child.kill("SIGKILL");
              } catch {
                // already gone
              }
            settled();
          },
        );
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    // Whatever survived the kill must not keep US alive: an orphaned
    // grandchild holding the inherited pipes leaves the child's stdio
    // streams open, and an open stdio stream keeps the event loop running
    // (the lab's process never exited). Drop our ends and unreference the
    // handle; the streams are ours, nobody reads them after a kill.
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  await Promise.race([
    closed,
    new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS)),
  ]);
}
