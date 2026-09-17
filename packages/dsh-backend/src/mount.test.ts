import type { AgentEvent, BackendRuntime, EventBus } from "@herta/core";
import { InMemoryEventBus } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  DSH_BACKEND_ENV,
  DSH_BACKEND_VALUE,
  DSH_KNOBS,
  type DshBackendHandle,
  type DshBackendSetupInput,
  setupDshBackend,
} from "./mount.js";
import {
  DSH_BIN_ENV,
  DSH_SDK_ENV,
  DSH_SDK_MODULE,
  resolveDshSdk,
} from "./resolve-launch.js";

/** `process.execPath` is a real file, so `resolveDshBinPath` accepts it without
 *  needing a `@deepseek-ai/dsh` install; nothing is ever spawned in these
 *  tests because the SDK harness is lazy. */
const REAL_BIN = process.execPath;

function setup(overrides: Partial<DshBackendSetupInput> = {}): {
  handle: DshBackendHandle | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];
  const handle = setupDshBackend({
    workspaceRoot: "C:/ws",
    apiKey: undefined,
    env: {
      [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE,
      [DSH_KNOBS.bin]: REAL_BIN,
    },
    warn: (message) => warnings.push(message),
    homedir: "C:/Users/test",
    ...overrides,
  });
  return { handle, warnings };
}

function holder(current = "C:/ws"): { current: string } {
  return { current };
}

/** Fresh per call: the bus is part of the runtime memo's key, so a test that
 *  wants a memo hit must reuse the same one. */
function bus(): EventBus<AgentEvent> {
  return new InMemoryEventBus<AgentEvent>();
}

describe("setupDshBackend", () => {
  it("stays off when the knob is unset", () => {
    expect(
      setup({ env: { [DSH_KNOBS.bin]: REAL_BIN } }).handle,
    ).toBeUndefined();
  });

  it("stays off for any other knob value, without warning", () => {
    const { handle, warnings } = setup({
      env: { [DSH_BACKEND_ENV]: "builtin" },
    });
    expect(handle).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns and stays off when the knob is on but no CLI can be found", () => {
    // A silent fall back to the in-process backend would be worse than a
    // warning: the operator asked for the harness and would never learn that
    // the 板砖 are running on the other one. An explicit but missing path wins
    // over resolution, so this is deterministic.
    const { handle, warnings } = setup({
      env: {
        [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE,
        [DSH_KNOBS.bin]: "C:/nope/dsh-bin.js",
      },
    });
    expect(handle).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(DSH_BACKEND_ENV);
    expect(warnings[0]).toContain(DSH_KNOBS.bin);
  });

  it("honours the harness's own bare DSH_BIN name too", () => {
    const { handle } = setup({
      env: { [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE, DSH_BIN: REAL_BIN },
    });
    expect(handle).toBeDefined();
  });

  it("prefers the caller's knob over a conflicting ambient DSH_BIN", () => {
    // `resolveDshBinPath` falls back to `process.env['DSH_BIN']` for direct
    // callers; an explicit `binPath` must win, or a stray shell variable would
    // quietly reroute a launch spec that names its own.
    const saved = process.env[DSH_BIN_ENV];
    process.env[DSH_BIN_ENV] = "C:/definitely/not/here.js";
    try {
      const { handle } = setup({
        env: {
          [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE,
          [DSH_KNOBS.bin]: REAL_BIN,
        },
      });
      expect(handle).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env[DSH_BIN_ENV];
      else process.env[DSH_BIN_ENV] = saved;
    }
  });

  it("mounts a factory when the knob is on and the CLI resolves", () => {
    const { handle, warnings } = setup();
    expect(handle).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("reads the workspace per dispatch, not at setup time", () => {
    const { handle } = setup();
    const ws = holder("C:/first");
    const factory = handle?.makeRuntimeFactory({ wsHolder: ws, bus: bus() });
    const first = factory?.();
    // The holder moved after the factory was minted; a runtime cached at setup
    // time would hand back the same instance and keep the harness rooted at
    // the old workspace.
    ws.current = "C:/second";
    expect(factory?.()).not.toBe(first);
  });

  it("memoizes one runtime per workspace", () => {
    // The seam has no close(), so a fresh runtime per dispatch would leak one
    // harness subprocess per 板砖.
    const { handle } = setup();
    const shared = bus();
    const factory = handle?.makeRuntimeFactory({
      wsHolder: holder(),
      bus: shared,
    });
    const first = factory?.();
    expect(factory?.()).toBe(first);
    expect(factory?.()).toBe(first);
  });

  it("rebuilds the runtime when the bus changes, so narration cannot go stale", () => {
    // A runtime publishes onto the bus it was built with. Rebuilding the stack
    // hands over a fresh bus; reusing the old runtime would leave the new
    // bridge draining an empty bus, and the record would show a harness that
    // did nothing — the exact failure this wiring exists to prevent.
    const { handle } = setup();
    const ws = holder();
    const first = handle?.makeRuntimeFactory({ wsHolder: ws, bus: bus() });
    const second = handle?.makeRuntimeFactory({ wsHolder: ws, bus: bus() });
    expect(second?.()).not.toBe(first?.());
  });

  it("closes the previous runtime when the workspace changes", async () => {
    const { handle } = setup();
    const ws = holder("C:/first");
    const shared = bus();
    const factory = handle?.makeRuntimeFactory({ wsHolder: ws, bus: shared });
    const first = factory?.();
    ws.current = "C:/second";
    const second = factory?.();
    expect(second).not.toBe(first);
    // close() flips the flag before its first await, so this is observable
    // synchronously.
    await expect(first?.runBrief({ taskId: "t" })).rejects.toThrow(
      /after close/,
    );
    // ...and the replacement is live.
    expect(factory?.()).toBe(second);
  });

  it("reaps the child on close and tolerates a second close", async () => {
    const { handle } = setup();
    const factory = handle?.makeRuntimeFactory({
      wsHolder: holder(),
      bus: bus(),
    });
    const runtime = factory?.() as BackendRuntime;
    await handle?.close();
    await expect(runtime.runBrief({ taskId: "t" })).rejects.toThrow(
      /after close/,
    );
    await expect(handle?.close()).resolves.toBeUndefined();
  });

  it("close is a no-op when nothing was ever mounted", async () => {
    const { handle } = setup();
    await expect(handle?.close()).resolves.toBeUndefined();
  });

  it("shares the memo across factories, so a rebuild cannot fork a second child", () => {
    // session-wiring calls makeRuntimeFactory once per stack build, and the
    // stack can be rebuilt; the memo lives in setupDshBackend's closure
    // precisely so a rebuild reuses the live harness child instead of leaking
    // the old one.
    const { handle } = setup();
    const ws = holder();
    const shared = bus();
    const first = handle?.makeRuntimeFactory({ wsHolder: ws, bus: shared });
    const second = handle?.makeRuntimeFactory({ wsHolder: ws, bus: shared });
    expect(typeof first).toBe("function");
    expect(second?.()).toBe(first?.());
  });
});

describe("setupDshBackend — SDK location", () => {
  it("warns and stays off when the SDK path is named but missing", () => {
    // A bundled host MUST name the SDK (it ships no node_modules), so a wrong
    // path is the likeliest GUI misconfiguration; reporting it at mount time
    // beats a failure on the first 板砖.
    const { handle, warnings } = setup({
      env: {
        [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE,
        [DSH_KNOBS.bin]: REAL_BIN,
        [DSH_KNOBS.sdk]: "C:/nope/sdk/index.js",
      },
    });
    expect(handle).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SDK");
    expect(warnings[0]).toContain(DSH_KNOBS.sdk);
  });

  it("mounts when the SDK path exists", () => {
    // process.execPath is a real file; it is not a module, but the mount only
    // checks existence — the import happens on the first dispatch.
    const { handle, warnings } = setup({
      env: {
        [DSH_BACKEND_ENV]: DSH_BACKEND_VALUE,
        [DSH_KNOBS.bin]: REAL_BIN,
        [DSH_KNOBS.sdk]: REAL_BIN,
      },
    });
    expect(handle).toBeDefined();
    expect(warnings).toEqual([]);
  });
});

describe("resolveDshSdk", () => {
  it("defaults to the bare module id", () => {
    expect(resolveDshSdk({ env: {} })).toEqual({ module: DSH_SDK_MODULE });
  });

  it("ignores a blank or whitespace-only knob", () => {
    expect(resolveDshSdk({ env: { [DSH_SDK_ENV]: "" } })).toEqual({
      module: DSH_SDK_MODULE,
    });
    expect(resolveDshSdk({ env: { [DSH_SDK_ENV]: "   " } })).toEqual({
      module: DSH_SDK_MODULE,
    });
  });

  it("passes a non-absolute value through as a module id", () => {
    expect(resolveDshSdk({ env: { [DSH_SDK_ENV]: "@scope/pkg/sub" } })).toEqual(
      {
        module: "@scope/pkg/sub",
      },
    );
  });

  it("turns an absolute path into a file URL and reports the path", () => {
    const resolved = resolveDshSdk({
      env: { [DSH_SDK_ENV]: "C:\\sdk\\index.js" },
    });
    expect(resolved.module.startsWith("file:///")).toBe(true);
    // Percent-encoded where needed, but never a bare Windows path: Node's
    // `import()` rejects "C:\..." as a scheme-less specifier.
    expect(resolved.module).toContain("index.js");
    expect(resolved.path).toBeDefined();
  });

  it("prefers an explicit sdkPath over the env", () => {
    const resolved = resolveDshSdk({
      sdkPath: "D:\\other\\index.js",
      env: { [DSH_SDK_ENV]: "C:\\sdk\\index.js" },
    });
    expect(resolved.path?.startsWith("D:")).toBe(true);
  });
});
