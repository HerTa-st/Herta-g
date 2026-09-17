import { normalize } from "node:path";
import type {
  AgentEvent,
  AgentExecutionReport,
  EventBus,
  HertaToAgentBrief,
  RunBriefOptions,
} from "@herta/core";
import { InMemoryEventBus } from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { REAL_TURN_EVENTS } from "./__fixtures__/real-turn.js";
import {
  type DshHarnessFactoryOptions,
  type DshHarnessPort,
  type DshLaunchOptions,
  DshSdkRuntime,
  renderTaskText,
} from "./dsh-sdk-runtime.js";
import type { DshSessionEvent } from "./events.js";

const BRIEF: HertaToAgentBrief = { taskId: "task-1" };

const LAUNCH: DshLaunchOptions = {
  command: "node",
  args: ["/opt/dsh/bin.js", "--profile", "sdk-minimal"],
  cwd: "C:/ws",
  dshHome: "C:/ws/.herta/dsh-home",
  personaPrefix: "你是黑塔。",
};

interface FakeHarness extends DshHarnessPort {
  readonly runs: Array<{ input: string; sessionId: string | undefined }>;
  readonly notifications: (event: DshSessionEvent) => void;
}

/**
 * A harness stand-in that replays the captured turn through `onNotification`,
 * exactly as the SDK does — the runtime's job is to collect that stream, so
 * the fake must push events the same way rather than return them.
 */
function fakeHarness(
  events: readonly DshSessionEvent[] = REAL_TURN_EVENTS,
  overrides: Partial<DshHarnessPort> = {},
): FakeHarness {
  const runs: FakeHarness["runs"] = [];
  const notify: (event: DshSessionEvent) => void = () => undefined;
  return {
    runs,
    notifications: (event) => notify(event),
    async start() {
      await Promise.resolve();
    },
    async run(input, options) {
      runs.push({ input, sessionId: options?.sessionId });
      for (const event of events) {
        options?.onNotification?.({
          method: "session.event",
          params: { event },
        });
      }
      return { finalResponse: "ignored" };
    },
    async close() {
      await Promise.resolve();
    },
    ...overrides,
  };
}

function makeRuntime(
  harness: DshHarnessPort,
  options: {
    readonly launch?: Partial<DshLaunchOptions>;
    readonly now?: () => number;
    readonly bus?: EventBus<AgentEvent>;
  } = {},
): { runtime: DshSdkRuntime; created: DshHarnessFactoryOptions[] } {
  const created: DshHarnessFactoryOptions[] = [];
  const runtime = new DshSdkRuntime({
    launch: { ...LAUNCH, ...options.launch },
    ...(options.bus === undefined ? {} : { bus: options.bus }),
    now: options.now ?? (() => 1_700_000_000_000),
    createHarness: (factoryOptions) => {
      created.push(factoryOptions);
      return harness;
    },
  });
  return { runtime, created };
}

describe("renderTaskText", () => {
  it("renders the user's own words as the task", () => {
    const text = renderTaskText({ userMessages: [{ text: "修一下登录" }] });
    expect(text).toContain("修一下登录");
  });

  it("omits empty sections instead of emitting blank framing", () => {
    expect(renderTaskText({})).toBe("");
    expect(renderTaskText({ userMessages: [] })).toBe("");
  });

  it("orders context before the task so the task reads last", () => {
    const text = renderTaskText({
      userMessages: [{ text: "TASK" }],
      recentDialogue: "DIALOGUE",
      workingHistory: "HISTORY",
    });
    expect(text.indexOf("DIALOGUE")).toBeLessThan(text.indexOf("HISTORY"));
    expect(text.indexOf("HISTORY")).toBeLessThan(text.indexOf("TASK"));
  });

  it("ignores blank context even when supplied", () => {
    const text = renderTaskText({
      userMessages: [{ text: "TASK" }],
      recentDialogue: "   ",
    });
    expect(text).toBe(renderTaskText({ userMessages: [{ text: "TASK" }] }));
  });
});

describe("DshSdkRuntime.runBrief", () => {
  it("projects the captured turn onto the bridge contract", async () => {
    const harness = fakeHarness();
    const { runtime } = makeRuntime(harness);

    const report = await runtime.runBrief(BRIEF, {
      userMessages: [{ text: "写个文件" }],
    });

    expect(report.taskId).toBe("task-1");
    expect(report.status).toBe("completed");
    expect(report.changedFiles.map((file) => file.path)).toEqual([
      "fixture.txt",
    ]);
    expect(harness.runs).toHaveLength(1);
  });

  it("republishes every tool call onto the session bus", async () => {
    // The bridge narrates the record from bus events, not from the returned
    // report. A harness that only filled in the report ran eight commands and
    // still rendered as 差分协处理器 无产出.
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((event) => seen.push(event));
    const { runtime } = makeRuntime(fakeHarness(), { bus });

    await runtime.runBrief(BRIEF, { userMessages: [{ text: "写个文件" }] });

    const started = seen.filter((event) => event.type === "tool.call.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      layer: "backend",
      tool: "bash",
      inputSummary:
        "Set-Content -Path fixture.txt -Value 'ok'; Get-Content -Path fixture.txt",
    });
    expect(
      seen.filter((event) => event.type === "tool.call.finished"),
    ).toHaveLength(1);
  });

  it("runs without a bus, because the projection is narration only", async () => {
    const { runtime } = makeRuntime(fakeHarness());
    const report = await runtime.runBrief(BRIEF, {});
    expect(report.status).toBe("completed");
  });

  it("scopes the call-id ledger to one brief", async () => {
    // A reused callId in a later turn must not be attributed to the tool name
    // remembered from the previous one.
    const bus = new InMemoryEventBus<AgentEvent>();
    const seen: AgentEvent[] = [];
    bus.onAny((event) => seen.push(event));
    const { runtime } = makeRuntime(fakeHarness(), { bus });

    await runtime.runBrief(BRIEF, {});
    await runtime.runBrief(BRIEF, {});

    expect(
      seen.filter((event) => event.type === "tool.call.started"),
    ).toHaveLength(2);
    expect(
      seen.filter((event) => event.type === "tool.call.finished"),
    ).toHaveLength(2);
  });

  it("sends the rendered task text and a fresh session id per brief", async () => {
    const harness = fakeHarness();
    const { runtime } = makeRuntime(harness);

    await runtime.runBrief(BRIEF, { userMessages: [{ text: "第一个" }] });
    await runtime.runBrief(BRIEF, { userMessages: [{ text: "第二个" }] });

    expect(harness.runs[0]?.input).toContain("第一个");
    expect(harness.runs[1]?.input).toContain("第二个");
    // DSH persists sessions by id and rejects a reuse; a shared id would also
    // leak the previous brief's transcript into the next turn.
    expect(harness.runs[0]?.sessionId).not.toBe(harness.runs[1]?.sessionId);
  });

  it("starts the child once and reuses it across briefs", async () => {
    const harness = fakeHarness();
    const started = vi.spyOn(harness, "start");
    const { runtime } = makeRuntime(harness);

    await runtime.runBrief(BRIEF, {});
    await runtime.runBrief(BRIEF, {});
    await runtime.runBrief(BRIEF, {});

    expect(started).toHaveBeenCalledTimes(1);
  });

  it("passes DSH_HOME, the persona, and extra env to the launch spec", async () => {
    const harness = fakeHarness();
    const { runtime, created } = makeRuntime(harness, {
      launch: { env: { DEEPSEEK_API_KEY: "secret", DROP_ME: undefined } },
    });

    await runtime.runBrief(BRIEF, {});

    const launch = created[0]?.launch;
    expect(launch?.command).toBe("node");
    expect(launch?.args).toEqual([
      "/opt/dsh/bin.js",
      "--profile",
      "sdk-minimal",
    ]);
    expect(launch?.env.DSH_HOME).toBe(normalize("C:/ws/.herta/dsh-home"));
    expect(launch?.env.DSH_SYSTEM_PROMPT).toBe("你是黑塔。");
    expect(launch?.env.DEEPSEEK_API_KEY).toBe("secret");
    expect(launch?.env).not.toHaveProperty("DROP_ME");
    // The host environment must survive: the child needs PATH and SystemRoot.
    expect(launch?.env.PATH).toBe(process.env.PATH);
  });

  it("omits DSH_SYSTEM_PROMPT when no persona is configured", async () => {
    const harness = fakeHarness();
    const { runtime, created } = makeRuntime(harness, {
      launch: { personaPrefix: undefined },
    });

    await runtime.runBrief(BRIEF, {});

    expect(created[0]?.launch.env).not.toHaveProperty("DSH_SYSTEM_PROMPT");
  });

  it("hands the child a native DSH_HOME even when the spec uses forward slashes", async () => {
    // The profile loader walks this path itself; mixed separators survive
    // Node but not the harness's own path handling.
    const harness = fakeHarness();
    const { runtime, created } = makeRuntime(harness, {
      launch: { dshHome: "C:/ws/mixed/../.herta/dsh-home" },
    });

    await runtime.runBrief(BRIEF, {});

    expect(created[0]?.launch.env.DSH_HOME).toBe(
      normalize("C:/ws/.herta/dsh-home"),
    );
  });

  it("serializes overlapping briefs instead of interleaving them", async () => {
    const order: string[] = [];
    const harness = fakeHarness(REAL_TURN_EVENTS, {
      async run(input) {
        order.push(`start:${input}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${input}`);
        return {};
      },
    });
    const { runtime } = makeRuntime(harness);

    await Promise.all([
      runtime.runBrief(BRIEF, { userMessages: [{ text: "A" }] }),
      runtime.runBrief(BRIEF, { userMessages: [{ text: "B" }] }),
    ]);

    expect(order).toHaveLength(4);
    expect(order[0]?.startsWith("start:")).toBe(true);
    expect(order[1]?.startsWith("end:")).toBe(true);
    expect(order[2]?.startsWith("start:")).toBe(true);
    expect(order[3]?.startsWith("end:")).toBe(true);
  });

  it("keeps serving briefs after one fails", async () => {
    let calls = 0;
    const harness = fakeHarness(REAL_TURN_EVENTS, {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error("transport died");
        return {};
      },
    });
    const { runtime } = makeRuntime(harness);

    const failed = await runtime.runBrief(BRIEF, {});
    const ok = await runtime.runBrief(BRIEF, {});

    expect(failed.status).toBe("failed");
    expect(ok.status).toBe("partial");
  });

  it("reports a start failure as a transport error, then retries the start", async () => {
    let attempts = 0;
    const harness = fakeHarness(REAL_TURN_EVENTS, {
      async start() {
        attempts += 1;
        if (attempts === 1) throw new Error("MISSING_CREDENTIAL");
        return undefined;
      },
    });
    const { runtime } = makeRuntime(harness);

    const first = await runtime.runBrief(BRIEF, {});
    const second = await runtime.runBrief(BRIEF, {});

    expect(first.status).toBe("failed");
    expect(
      first.residualRisks.some((risk) => risk.includes("MISSING_CREDENTIAL")),
    ).toBe(true);
    // The SDK swaps in a fresh client after a failed handshake, so caching the
    // failure would strand the session forever.
    expect(attempts).toBe(2);
    expect(second.status).toBe("completed");
  });

  it("refuses a brief after close", async () => {
    const harness = fakeHarness();
    const { runtime } = makeRuntime(harness);

    await runtime.close();

    await expect(runtime.runBrief(BRIEF, {})).rejects.toThrow("after close()");
  });

  it("closes the child exactly once, and is idempotent", async () => {
    const harness = fakeHarness();
    const closed = vi.spyOn(harness, "close");
    const { runtime } = makeRuntime(harness);

    await runtime.runBrief(BRIEF, {});
    await runtime.close();
    await runtime.close();

    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("does not spawn at all when closed before the first brief", async () => {
    const harness = fakeHarness();
    const started = vi.spyOn(harness, "start");
    const { runtime, created } = makeRuntime(harness);

    await runtime.close();

    expect(created).toHaveLength(0);
    expect(started).not.toHaveBeenCalled();
  });
});

describe("DshSdkRuntime abort handling", () => {
  /** A harness whose turn never settles until released. */
  function hangingHarness(): { harness: DshHarnessPort; release: () => void } {
    let notify: ((event: DshSessionEvent) => void) | undefined;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      harness: {
        async start() {
          await Promise.resolve();
        },
        async run(_input, options) {
          notify = options?.onNotification
            ? (event) =>
                options.onNotification?.({
                  method: "session.event",
                  params: { event },
                })
            : undefined;
          // A first partial turn, so the aborted report has something real.
          notify?.(REAL_TURN_EVENTS[10] as DshSessionEvent);
          await settled;
          return {};
        },
        async close() {
          await Promise.resolve();
        },
      },
      release,
    };
  }

  it("returns interrupted without claiming the harness produced the outcome", async () => {
    const { harness } = hangingHarness();
    const { runtime } = makeRuntime(harness);
    const controller = new AbortController();

    const brief = runtime.runBrief(BRIEF, { signal: controller.signal });
    controller.abort();
    const report: AgentExecutionReport = await brief;

    expect(report.status).toBe("interrupted");
    expect(report.taskId).toBe("task-1");
    expect(report.residualRisks).toContain(
      "本地中止：wire 无 cancel，DSH 回合未收到取消，后台结果仅供参考",
    );
    // The orphaned call has no result yet, so it must not become evidence.
    expect(report.evidence).toEqual([]);
  });

  it("returns interrupted immediately when the signal is already aborted", async () => {
    const { harness } = hangingHarness();
    const { runtime } = makeRuntime(harness);

    const report = await runtime.runBrief(BRIEF, {
      signal: AbortSignal.abort(),
    });

    expect(report.status).toBe("interrupted");
  });

  it("keeps the next brief queued behind the aborted turn", async () => {
    const { harness, release } = hangingHarness();
    const { runtime } = makeRuntime(harness);
    const controller = new AbortController();
    const order: string[] = [];

    const abortedBrief = runtime.runBrief(BRIEF, { signal: controller.signal });
    controller.abort();
    await abortedBrief;
    order.push("aborted-returned");

    const next = runtime.runBrief(BRIEF, {}).then((report) => {
      order.push("next-returned");
      return report;
    });
    await Promise.resolve();
    expect(order).toEqual(["aborted-returned"]);

    release();
    await next;
    expect(order).toEqual(["aborted-returned", "next-returned"]);
  });

  it("stops listening for aborts once the brief settles", async () => {
    const harness = fakeHarness();
    const { runtime } = makeRuntime(harness);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");

    await runtime.runBrief(BRIEF, { signal: controller.signal });

    expect(removed).toHaveBeenCalled();
  });
});

describe("DshSdkRuntime typing", () => {
  it("satisfies the BackendRuntime contract", async () => {
    const harness = fakeHarness();
    const { runtime } = makeRuntime(harness);
    // Assigning through the seam's own type is the assertion: if runBrief's
    // signature drifts from BackendRuntime, this fails to compile.
    const backend: {
      runBrief(
        brief: HertaToAgentBrief,
        opts?: RunBriefOptions,
      ): Promise<AgentExecutionReport>;
    } = runtime;

    expect((await backend.runBrief(BRIEF, {})).taskId).toBe("task-1");
  });
});
