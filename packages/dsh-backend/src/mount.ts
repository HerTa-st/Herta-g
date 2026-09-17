import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentEvent, BackendRuntime, EventBus } from "@herta/core";
import { DshSdkRuntime } from "./dsh-sdk-runtime.js";
import {
  DSH_BIN_ENV,
  DSH_SDK_ENV,
  type ResolveDshLaunchInput,
  resolveDshLaunch,
  resolveDshSdk,
} from "./resolve-launch.js";
import { createSdkHarness } from "./sdk-harness.js";

/**
 * Mounting the harness is host work, not wiring work: the CLI and the GUI both
 * need the same env gate, the same memoization and the same release, and the
 * only thing they differ in is WHEN the release happens. So it lives here,
 * beside the runtime it mounts, instead of inside either host.
 */

/** Env knob that turns the harness on; anything else keeps the in-process backend. */
export const DSH_BACKEND_ENV = "HERTA_BACKEND";
export const DSH_BACKEND_VALUE = "dsh";

/**
 * Herta-namespaced overrides. The bare harness names (`DSH_BIN`, `DSH_SDK`) are
 * honoured as fallbacks, so a machine already set up the harness way works
 * unchanged.
 */
export const DSH_KNOBS = {
  bin: "HERTA_DSH_BIN",
  sdk: "HERTA_DSH_SDK",
  home: "HERTA_DSH_HOME",
  profile: "HERTA_DSH_PROFILE",
  persona: "HERTA_DSH_PERSONA",
  model: "HERTA_DSH_MODEL",
} as const;

export interface DshBackendSetupInput {
  /** Where to seed the launch spec from; the workspace is re-read per dispatch. */
  readonly workspaceRoot: string;
  /**
   * The same credential the in-process backend uses. Read ONCE, at mount time:
   * the harness child is spawned with it, so a key entered later takes effect
   * on the next mount, not on the next dispatch.
   */
  readonly apiKey: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
  /** Injectable for tests; defaults to `os.homedir()`. */
  readonly homedir?: string;
}

export interface DshBackendHandle {
  /** Pass straight to `BackendStackOpts.makeRuntimeFactory`. */
  readonly makeRuntimeFactory: (deps: {
    readonly wsHolder: { readonly current: string };
    /**
     * The session bus the bridge drains. Required, not optional: a harness
     * mounted without one runs its commands and reports nothing to the record,
     * which is indistinguishable from a no-op delegation.
     */
    readonly bus: EventBus<AgentEvent>;
  }) => () => BackendRuntime;
  /** Reaps the harness child, if one was ever spawned. Idempotent. */
  close(): Promise<void>;
}

/**
 * Mounts the DeepSeek Harness backend when `HERTA_BACKEND=dsh`, otherwise
 * returns `undefined` so the caller keeps Herta's own backend.
 *
 * The runtime is MEMOIZED rather than minted per dispatch. The `BackendRuntime`
 * seam has no `close()`, so a per-dispatch runtime would leak one harness
 * subprocess per 板砖 — and the driver already serializes dispatches, so
 * sharing one child costs nothing in isolation. The child is instead rotated
 * when the effective workspace changes, because the harness roots its sandbox
 * at its own cwd and cannot be retargeted in place.
 *
 * The caller OWNS the returned handle and must `close()` it: nothing here knows
 * when a host is finished with the harness. Herta's own approval prompts do not
 * cover the mounted harness either — see the README.
 */
export function setupDshBackend(
  input: DshBackendSetupInput,
): DshBackendHandle | undefined {
  if (input.env[DSH_BACKEND_ENV] !== DSH_BACKEND_VALUE) return undefined;

  // Resolved once: the SDK is a module the host imports, not a per-dispatch
  // choice, so re-resolving it per brief would only invite drift.
  const sdk = resolveDshSdk({
    env: input.env,
    ...(input.env[DSH_KNOBS.sdk] === undefined
      ? {}
      : { sdkPath: input.env[DSH_KNOBS.sdk] }),
  });

  const shared: Omit<ResolveDshLaunchInput, "cwd"> = {
    // Herta's own namespace wins, but the harness docs' bare name is honoured
    // too. Read from `input.env` rather than letting `resolveDshBinPath` fall
    // back to the ambient `process.env`, so the knob the caller passed is the
    // knob that is used.
    binPath: input.env[DSH_KNOBS.bin] ?? input.env[DSH_BIN_ENV],
    apiKey: input.apiKey,
    env: input.env,
    home: input.homedir ?? homedir(),
    ...(input.env[DSH_KNOBS.home] === undefined
      ? {}
      : { dshHome: input.env[DSH_KNOBS.home] }),
    ...(input.env[DSH_KNOBS.profile] === undefined
      ? {}
      : { profile: input.env[DSH_KNOBS.profile] }),
    ...(input.env[DSH_KNOBS.persona] === undefined
      ? {}
      : { personaPrefix: input.env[DSH_KNOBS.persona] }),
    // `HERTA_BACKEND_MODEL` is deliberately NOT forwarded: it names Herta's own
    // model catalog ("deepseek-flash"), which the harness does not serve.
    ...(input.env[DSH_KNOBS.model] === undefined
      ? {}
      : { model: input.env[DSH_KNOBS.model] }),
  };

  // Resolve eagerly so a missing install is reported once, at startup, instead
  // of silently falling back on the first 板砖.
  if (resolveDshLaunch({ cwd: input.workspaceRoot, ...shared }) === null) {
    input.warn(missingInstallWarning("CLI", [DSH_KNOBS.bin, DSH_BIN_ENV]));
    return undefined;
  }
  if (sdk.path !== undefined && !existsSync(sdk.path)) {
    input.warn(missingInstallWarning("SDK", [DSH_KNOBS.sdk, DSH_SDK_ENV]));
    return undefined;
  }

  let mounted: {
    readonly ws: string;
    readonly bus: EventBus<AgentEvent>;
    readonly runtime: DshSdkRuntime;
  } | null = null;

  const makeRuntimeFactory = (deps: {
    readonly wsHolder: { readonly current: string };
    readonly bus: EventBus<AgentEvent>;
  }): (() => BackendRuntime) => {
    return () => {
      const ws = deps.wsHolder.current;
      // The bus is part of the memo key, not just the workspace: a runtime
      // publishes onto the one bus it was built with, and a rebuilt stack
      // arrives with a fresh one. Reusing the old runtime would hand the new
      // bridge an empty bus — the record would show a harness that did
      // nothing, which is the failure this wiring exists to prevent.
      if (mounted !== null && (mounted.ws !== ws || mounted.bus !== deps.bus)) {
        // Fire-and-forget: the old child is unreachable from here on, and the
        // caller is already awaiting this dispatch.
        void mounted.runtime.close().catch(() => undefined);
        mounted = null;
      }
      if (mounted === null) {
        const launch = resolveDshLaunch({ cwd: ws, ...shared });
        if (launch === null) {
          // Only reachable if the install vanished mid-session, or if the
          // workspace rotated onto a path the explicit bin cannot serve.
          throw new Error(
            "herta: the DeepSeek Harness CLI disappeared mid-session",
          );
        }
        mounted = {
          ws,
          bus: deps.bus,
          runtime: new DshSdkRuntime({
            launch,
            bus: deps.bus,
            createHarness: (options) => createSdkHarness(options, sdk.module),
          }),
        };
      }
      return mounted.runtime;
    };
  };

  return {
    makeRuntimeFactory,
    async close() {
      const current = mounted;
      mounted = null;
      if (current !== null) await current.runtime.close();
    },
  };
}

function missingInstallWarning(
  what: "CLI" | "SDK",
  knobs: readonly string[],
): string {
  return (
    `herta: ${DSH_BACKEND_ENV}=${DSH_BACKEND_VALUE} but no DeepSeek Harness ${what} was found ` +
    `(install @deepseek-ai/dsh and @deepseek-ai/dsh-sdk-client in their own tree ` +
    `and set ${knobs.join(" or ")}); running the in-process backend\n`
  );
}
