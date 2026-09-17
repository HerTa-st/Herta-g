import { normalize } from "node:path";
import type {
  AgentEvent,
  AgentExecutionReport,
  BackendRuntime,
  EventBus,
  HertaToAgentBrief,
  RunBriefOptions,
} from "@herta/core";
import { errorMessage, serializeUserHistory } from "@herta/core";
import { DshBusTranslator } from "./bus-events.js";
import type {
  DshNotification,
  DshRunResult,
  DshSessionEvent,
} from "./events.js";
import { projectRun } from "./project-report.js";

/**
 * The slice of `@deepseek-ai/dsh-sdk-client`'s `DeepSeekHarness` this runtime
 * uses. Declared structurally rather than imported so the package does not
 * have to depend on a `restricted`-access SDK at build time, and so tests can
 * drive the whole runtime without spawning a subprocess.
 */
export interface DshHarnessPort {
  start(): Promise<void>;
  run(
    input: string,
    options?: {
      readonly sessionId?: string;
      readonly onNotification?: (notification: DshNotification) => void;
    },
  ): Promise<DshRunResult>;
  close(): Promise<void>;
}

export interface DshLaunchOptions {
  /** Executable to spawn — normally `process.execPath`. */
  readonly command: string;
  /** Arguments: the resolved `dsh` `bin.js` plus `--profile <name>`. */
  readonly args: readonly string[];
  /** Working directory the harness session is rooted at. */
  readonly cwd: string;
  /**
   * The DSH home Herta owns. Kept as its own directory: the harness resolves
   * profile plugins by walking up from here, so pointing it inside a tree that
   * also holds a flat SDK install makes it pick up a second, incompatible copy
   * of `@deepseek-ai/dsh-tools` (see the integration note in the README's
   * deployment section).
   */
  readonly dshHome: string;
  /**
   * Persona text forwarded as `DSH_SYSTEM_PROMPT`, which the `sdk-minimal`
   * profile wires to `system-prompt.personaPrefix`. This is the harness's
   * only zero-code persona seam; injecting here means Herta's voice is a
   * launch parameter, not a patched profile file.
   */
  readonly personaPrefix?: string;
  /** Extra environment for the child; `undefined` values are dropped. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface DshHarnessFactoryOptions {
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly requestTimeoutMs?: number;
  };
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Builds a harness port. May be async so the production implementation can
 * import the SDK lazily; tests return a fake synchronously.
 */
export type DshHarnessFactory = (
  options: DshHarnessFactoryOptions,
) => DshHarnessPort | Promise<DshHarnessPort>;

export interface DshSdkRuntimeDeps {
  readonly launch: DshLaunchOptions;
  /** Injected so tests substitute a fake and never spawn a process. */
  readonly createHarness: DshHarnessFactory;
  /**
   * The session bus the narrative bridge drains. Give it one and every harness
   * tool call is republished as Herta's own `tool.call.*` events, which is what
   * makes the coprocessor's work visible in the record; omit it and the bridge
   * only ever sees the returned report, so a turn that ran eight commands still
   * renders as `差分协处理器 无产出`. Optional because the projection is
   * narration — a host without a bus loses the operation rows, not the run.
   */
  readonly bus?: EventBus<AgentEvent>;
  /** Clock, injectable for deterministic session ids in tests. */
  readonly now?: () => number;
}

/**
 * A `BackendRuntime` that delegates to an out-of-process DeepSeek Harness.
 *
 * Lifecycle: one child process per runtime instance, started lazily on the
 * first brief and reused for every session id the actor hands us — DSH
 * persists sessions by id, so reusing an id is an error, and a fresh id per
 * brief is what keeps the harness from inheriting the last brief's transcript.
 *
 * Concurrency: briefs are serialized. The harness is single-agent, so two
 * overlapping prompts would interleave on one inbox. A user abort therefore
 * does NOT cancel the harness turn — the wire has no cancel — it only ends
 * this call's wait, and the queue stays held until the orphaned turn settles.
 */
export class DshSdkRuntime implements BackendRuntime {
  private readonly deps: DshSdkRuntimeDeps;
  private harness: DshHarnessPort | null = null;
  private starting: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private sessionCounter = 0;
  /** Latest run's collector, read when an abort ends the wait early. */
  private partialEvents: readonly DshSessionEvent[] = [];

  constructor(deps: DshSdkRuntimeDeps) {
    this.deps = deps;
  }

  async runBrief(
    brief: HertaToAgentBrief,
    opts: RunBriefOptions = {},
  ): Promise<AgentExecutionReport> {
    if (this.closed) {
      throw new Error("DshSdkRuntime.runBrief called after close()");
    }

    const previous = this.tail;
    let settle!: () => void;
    this.tail = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // A predecessor's failure is its own caller's problem; it must not fail
    // this brief too.
    await previous.catch(() => undefined);

    const work = this.runOne(brief, opts).finally(settle);
    return await this.awaitWithAbort(work, brief.taskId, opts.signal);
  }

  /** Ends the child process. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const harness = this.harness;
    this.harness = null;
    this.starting = null;
    if (harness !== null) await harness.close();
  }

  private async awaitWithAbort(
    work: Promise<AgentExecutionReport>,
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentExecutionReport> {
    if (signal === undefined) return await work;
    if (signal.aborted) {
      return await abortedReport(
        taskId,
        work,
        () => this.partialEvents,
        this.deps.launch.cwd,
      );
    }

    let onAbort!: () => void;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const outcome = await Promise.race([
        work.then((report) => ({ kind: "done" as const, report })),
        aborted,
      ]);
      if (outcome === "aborted") {
        return await abortedReport(
          taskId,
          work,
          () => this.partialEvents,
          this.deps.launch.cwd,
        );
      }
      return outcome.report;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async runOne(
    brief: HertaToAgentBrief,
    opts: RunBriefOptions,
  ): Promise<AgentExecutionReport> {
    const events: DshSessionEvent[] = [];
    this.partialEvents = events;
    const workspace = this.deps.launch.cwd;
    // Per-dispatch: the call-id ledger must not survive a turn, or a reused id
    // would attribute a later result to an earlier tool.
    const translator =
      this.deps.bus === undefined
        ? null
        : new DshBusTranslator({
            bus: this.deps.bus,
            workspaceRoot: workspace,
          });

    let harness: DshHarnessPort;
    try {
      harness = await this.ensureStarted();
    } catch (error) {
      return projectRun({
        taskId: brief.taskId,
        events,
        workspace,
        transportError: errorMessage(error),
      });
    }

    try {
      await harness.run(renderTaskText(opts), {
        sessionId: this.nextSessionId(),
        onNotification: (notification) => {
          const event = notification.params?.event;
          if (event === undefined) return;
          events.push(event);
          translator?.translate(event);
        },
      });
    } catch (error) {
      return projectRun({
        taskId: brief.taskId,
        events,
        workspace,
        transportError: errorMessage(error),
      });
    }

    return projectRun({ taskId: brief.taskId, events, workspace });
  }

  private nextSessionId(): string {
    this.sessionCounter += 1;
    const stamp = (this.deps.now ?? Date.now)();
    return `herta-${stamp}-${this.sessionCounter}`;
  }

  private async ensureStarted(): Promise<DshHarnessPort> {
    if (this.harness !== null) return this.harness;
    this.starting ??= this.startHarness();
    await this.starting;
    if (this.harness === null) throw new Error("DSH harness did not start");
    return this.harness;
  }

  private async startHarness(): Promise<void> {
    const { launch, createHarness } = this.deps;
    const harness = await createHarness({
      launch: {
        command: launch.command,
        args: [...launch.args],
        cwd: launch.cwd,
        env: composeEnv(launch),
        ...(launch.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: launch.requestTimeoutMs }),
      },
      cwd: launch.cwd,
      ...(launch.provider === undefined ? {} : { provider: launch.provider }),
      ...(launch.model === undefined ? {} : { model: launch.model }),
    });

    try {
      await harness.start();
    } catch (error) {
      // The SDK reaps a failed handshake and swaps in a fresh client, so a
      // later brief may retry: forget the attempt instead of caching failure.
      this.starting = null;
      await harness.close().catch(() => undefined);
      throw error;
    }

    if (this.closed) {
      // close() landed while the handshake was in flight — don't leak the child.
      await harness.close();
      return;
    }
    this.harness = harness;
  }
}

function composeEnv(launch: DshLaunchOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // Herta OWNS the harness home, so the resolution above (HERTA_DSH_HOME,
  // else `<home>/.herta/dsh-home`) is applied LAST and wins over the ambient
  // layer. The caller hands us `process.env` as the extra environment, and a
  // host that is itself DSH — or any operator who exported DSH_HOME — would
  // otherwise clobber the child's home with their own. The child then looks
  // for Herta's profile in a foreign home and dies on the first brief with
  // `profile "<name>" does not exist`, which reads like a missing install.
  // The persona is Herta's launch parameter for the same reason.
  env.DSH_HOME = normalize(launch.dshHome);
  if (launch.personaPrefix !== undefined && launch.personaPrefix.length > 0) {
    env.DSH_SYSTEM_PROMPT = launch.personaPrefix;
  }
  return env;
}

/**
 * Renders the brief's task text.
 *
 * Reuses core's `serializeUserHistory` on purpose: its contract — "the user's
 * own words are the task" — is backend-agnostic, and it contains none of
 * Herta's own tool contract, which the harness would only fight with its own.
 * `HertaToAgentBrief` stays zero-parameter; the task is the user's speech.
 */
export function renderTaskText(opts: RunBriefOptions): string {
  const lang = opts.lang ?? "zh";
  const sections: string[] = [];

  const dialogue = opts.recentDialogue?.trim();
  if (dialogue !== undefined && dialogue.length > 0) sections.push(dialogue);

  const history = opts.workingHistory?.trim();
  if (history !== undefined && history.length > 0) sections.push(history);

  const userHistory = serializeUserHistory(
    opts.userMessages ?? [],
    lang,
    opts.omittedUserMessages ?? 0,
  );
  if (userHistory.length > 0) sections.push(userHistory);

  return sections.join("\n\n").trim();
}

/**
 * Falls back to whatever the aborted wait had collected.
 *
 * The orphaned turn still holds the queue, so its eventual report is not lost
 * to the process — it is simply not this call's answer. `interrupted` is
 * truthful here: the stop was local and the backend never heard about it, so
 * the report must not claim the harness produced this outcome.
 */
async function abortedReport(
  taskId: string,
  work: Promise<AgentExecutionReport>,
  events: () => readonly DshSessionEvent[],
  workspace: string,
): Promise<AgentExecutionReport> {
  // The orphaned turn keeps holding the queue; its report is not this call's
  // answer. Attaching a sink keeps a later rejection from going unhandled.
  work.then(
    () => undefined,
    () => undefined,
  );
  const partial = projectRun({ taskId, events: events(), workspace });
  return {
    ...partial,
    status: "interrupted",
    residualRisks: [
      ...partial.residualRisks,
      "本地中止：wire 无 cancel，DSH 回合未收到取消，后台结果仅供参考",
    ],
  };
}
