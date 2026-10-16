import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDeviceSceneBackendForTest } from "./capability.js";
import {
  DeviceScene,
  SCENE_REBUILD_DELAY_MS,
  SCENE_REBUILD_LIMIT,
} from "./DeviceScene.js";

const createDeviceScene = vi.fn();
vi.mock("./scene.js", () => ({
  createDeviceScene: (o: unknown) => createDeviceScene(o),
}));

const flush = async (): Promise<void> => {
  // capability probe → dynamic import → createDeviceScene: three awaits.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetDeviceSceneBackendForTest();
  createDeviceScene.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => null) as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeviceScene (ADR 0057 §4)", () => {
  it("reports not-live and never builds the scene when there is no GPU path (jsdom)", async () => {
    const onLive = vi.fn();
    const { container } = render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    expect(
      container.querySelector("canvas.device-scene-canvas"),
    ).not.toBeNull();
    await act(flush);
    expect(onLive).toHaveBeenCalledWith(false);
    expect(createDeviceScene).not.toHaveBeenCalled();
  });

  it("builds the scene on a GPU path, goes live after the first frame, forwards inputs, disposes on unmount", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({ destroy: () => undefined }),
      }),
    };
    vi.stubGlobal("navigator", { ...navigator, gpu });
    const handle = {
      stats: {
        backend: "webgpu",
        loadMs: 12,
        compileMs: 5,
        firstFrameMs: 3,
        presentMs: 2,
      },
      snapshot: async () => null,
      update: vi.fn(),
      dispose: vi.fn(),
    };
    createDeviceScene.mockImplementation(async () => handle);
    const onLive = vi.fn();
    const { container, rerender, unmount } = render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    await act(flush);
    expect(createDeviceScene).toHaveBeenCalledTimes(1);
    const opts = createDeviceScene.mock.calls[0]?.[0] as {
      forceWebGL: boolean;
      assetUrl: (f: string) => string;
      initial: { state: string };
    };
    expect(opts.forceWebGL).toBe(false);
    expect(opts.assetUrl("device.glb")).toBe(
      "herta-asset://device-scene/device.glb",
    );
    expect(opts.initial.state).toBe("idle");
    expect(onLive).toHaveBeenLastCalledWith(true);
    const canvas = container.querySelector(
      "canvas.device-scene-canvas",
    ) as HTMLCanvasElement;
    expect(canvas.dataset.backend).toBe("webgpu");

    rerender(
      <DeviceScene
        state="delegated"
        theme="dark"
        paused={true}
        liftPx={6}
        onLive={onLive}
      />,
    );
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: "delegated",
        theme: "dark",
        paused: true,
        liftPx: 6,
      }),
    );
    unmount();
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("returns the card to flat when the scene reports a fallback, and when building throws", async () => {
    const gpu = { requestAdapter: async () => null };
    vi.stubGlobal("navigator", { ...navigator, gpu });
    // No adapter but a hardware WebGL2 context → the WebGL2 path.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
      type: string,
    ) =>
      type === "webgl2"
        ? {
            getExtension: () => null,
            getParameter: () => "NVIDIA GeForce",
            RENDERER: 0,
          }
        : null) as typeof HTMLCanvasElement.prototype.getContext);
    let fallback: (() => void) | null = null;
    const handle = {
      stats: {
        backend: "webgl2",
        loadMs: 1,
        compileMs: 1,
        firstFrameMs: 1,
        presentMs: 1,
      },
      snapshot: async () => null,
      update: vi.fn(),
      dispose: vi.fn(),
    };
    createDeviceScene.mockImplementation(
      async (o: { onFallback: () => void }) => {
        fallback = o.onFallback;
        return handle;
      },
    );
    const onLive = vi.fn();
    render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive}
      />,
    );
    await act(flush);
    expect(onLive).toHaveBeenLastCalledWith(true);
    expect(
      (createDeviceScene.mock.calls[0]?.[0] as { forceWebGL: boolean })
        .forceWebGL,
    ).toBe(true);
    act(() => {
      fallback?.();
    });
    expect(onLive).toHaveBeenLastCalledWith(false);

    cleanup();
    resetDeviceSceneBackendForTest();
    createDeviceScene.mockImplementation(async () => {
      throw new Error("no wasm");
    });
    const onLive2 = vi.fn();
    render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={onLive2}
      />,
    );
    await act(flush);
    expect(onLive2).toHaveBeenLastCalledWith(false);
    vi.unstubAllGlobals();
  });
});

describe("DeviceScene — a lost GPU context (UX review 2026-09-22, item 23)", () => {
  it("rebuilds the scene on a FRESH canvas after a pause and goes live again; a scene that keeps losing it stops being rebuilt", async () => {
    vi.useFakeTimers();
    try {
      const gpu = { requestAdapter: async () => null };
      vi.stubGlobal("navigator", { ...navigator, gpu });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
        type: string,
      ) =>
        type === "webgl2"
          ? {
              getExtension: () => null,
              getParameter: () => "NVIDIA GeForce",
              RENDERER: 0,
            }
          : null) as typeof HTMLCanvasElement.prototype.getContext);
      const fallbacks: Array<() => void> = [];
      const canvases: HTMLCanvasElement[] = [];
      createDeviceScene.mockImplementation(
        async (o: { onFallback: () => void; canvas: HTMLCanvasElement }) => {
          fallbacks.push(o.onFallback);
          canvases.push(o.canvas);
          return {
            stats: {
              backend: "webgl2",
              loadMs: 1,
              compileMs: 1,
              firstFrameMs: 1,
              presentMs: 1,
            },
            snapshot: async () => null,
            update: vi.fn(),
            dispose: vi.fn(),
          };
        },
      );
      const onLive = vi.fn();
      render(
        <DeviceScene
          state="idle"
          theme="light"
          paused={false}
          liftPx={0}
          onLive={onLive}
        />,
      );
      await act(flush);
      expect(onLive).toHaveBeenLastCalledWith(true);
      // The context is lost: flat now…
      act(() => fallbacks[0]?.());
      expect(onLive).toHaveBeenLastCalledWith(false);
      // …and after the pause, a new build on a new canvas.
      await act(async () => {
        vi.advanceTimersByTime(SCENE_REBUILD_DELAY_MS);
      });
      await act(flush);
      expect(createDeviceScene).toHaveBeenCalledTimes(2);
      expect(canvases[1]).not.toBe(canvases[0]);
      expect(canvases[1]?.isConnected).toBe(true);
      expect(onLive).toHaveBeenLastCalledWith(true);
      // A context lost again and again within the minute stops at the limit.
      for (let i = 1; i <= SCENE_REBUILD_LIMIT + 1; i += 1) {
        act(() => fallbacks[i]?.());
        await act(async () => {
          vi.advanceTimersByTime(SCENE_REBUILD_DELAY_MS);
        });
        await act(flush);
      }
      expect(createDeviceScene).toHaveBeenCalledTimes(1 + SCENE_REBUILD_LIMIT);
      expect(onLive).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("DeviceScene — a loss that will be rebuilt is pending, not flat (release review 2026-10-13)", () => {
  it("reports pending for each rebuild and not-live only past the limit", async () => {
    vi.useFakeTimers();
    try {
      const gpu = { requestAdapter: async () => null };
      vi.stubGlobal("navigator", { ...navigator, gpu });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
        type: string,
      ) =>
        type === "webgl2"
          ? {
              getExtension: () => null,
              getParameter: () => "NVIDIA GeForce",
              RENDERER: 0,
            }
          : null) as typeof HTMLCanvasElement.prototype.getContext);
      const fallbacks: Array<() => void> = [];
      createDeviceScene.mockImplementation(
        async (o: { onFallback: () => void }) => {
          fallbacks.push(o.onFallback);
          return {
            stats: {
              backend: "webgl2",
              loadMs: 1,
              compileMs: 1,
              firstFrameMs: 1,
              presentMs: 1,
            },
            snapshot: async () => null,
            update: vi.fn(),
            dispose: vi.fn(),
          };
        },
      );
      const onLive = vi.fn();
      const onPending = vi.fn();
      render(
        <DeviceScene
          state="idle"
          theme="light"
          paused={false}
          liftPx={0}
          onLive={onLive}
          onPending={onPending}
        />,
      );
      await act(flush);
      expect(onLive).toHaveBeenLastCalledWith(true);
      for (let i = 0; i < SCENE_REBUILD_LIMIT; i += 1) {
        act(() => fallbacks[i]?.());
        expect(onPending).toHaveBeenCalledTimes(i + 1);
        expect(onLive).not.toHaveBeenCalledWith(false);
        await act(async () => {
          vi.advanceTimersByTime(SCENE_REBUILD_DELAY_MS);
        });
        await act(flush);
        expect(onLive).toHaveBeenLastCalledWith(true);
      }
      // One loss past the limit: no rebuild, and the card goes flat.
      act(() => fallbacks[SCENE_REBUILD_LIMIT]?.());
      expect(onPending).toHaveBeenCalledTimes(SCENE_REBUILD_LIMIT);
      expect(onLive).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("DeviceScene — a build abandoned mid-flight (ADR 0057 §6.5)", () => {
  it("unmounting mid-build aborts the build's signal, and a handle that lands after is disposed", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({ destroy: () => undefined }),
      }),
    };
    vi.stubGlobal("navigator", { ...navigator, gpu });
    let signal: AbortSignal | undefined;
    let land: (h: unknown) => void = () => undefined;
    const handle = {
      stats: {
        backend: "webgpu",
        loadMs: 1,
        compileMs: 1,
        firstFrameMs: 1,
        presentMs: 1,
      },
      snapshot: async () => null,
      update: vi.fn(),
      dispose: vi.fn(),
    };
    createDeviceScene.mockImplementation((o: { signal?: AbortSignal }) => {
      signal = o.signal;
      return new Promise((r) => {
        land = r;
      });
    });
    const { unmount } = render(
      <DeviceScene
        state="idle"
        theme="light"
        paused={false}
        liftPx={0}
        onLive={vi.fn()}
      />,
    );
    await act(flush);
    expect(createDeviceScene).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      land(handle);
      await flush();
    });
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
