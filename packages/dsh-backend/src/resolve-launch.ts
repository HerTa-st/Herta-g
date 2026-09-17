import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DshLaunchOptions } from "./dsh-sdk-runtime.js";

export interface ResolveDshLaunchInput {
  /** Workspace the harness session is rooted at. */
  readonly cwd: string;
  /** Explicit `dsh` entry point; wins over resolution. */
  readonly binPath?: string;
  /** Profile to boot. Defaults to `sdk-minimal`. */
  readonly profile?: string;
  /** Herta-owned DSH home. Defaults to `<home>/.herta/dsh-home`. */
  readonly dshHome?: string;
  /**
   * The user's home directory, used only to default `dshHome`. Passed in
   * rather than read from `os.homedir()` directly so the resolution stays pure
   * and testable — the convention `@herta/core`'s `workspacesBaseDir(home)`
   * already follows.
   */
  readonly home?: string;
  readonly personaPrefix?: string;
  /**
   * Model credential for the harness child. Passed through the environment
   * only — never written to a file. Absent means the harness falls back to
   * whatever the host environment already provides.
   */
  readonly apiKey?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  readonly provider?: string;
  readonly model?: string;
  /**
   * Whether the caller is an Electron main process, where `process.execPath`
   * is `electron.exe` rather than `node`. Injected rather than read so the
   * resolution stays testable; defaults to inspecting `process.versions`.
   */
  readonly electronMain?: boolean;
}

/** The profile whose Cordis tree is self-contained. */
export const DEFAULT_DSH_PROFILE = "sdk-minimal";

/** Env var the `sdk-minimal` profile reads the credential from. */
export const DSH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * Env var that makes an Electron binary run as plain Node.
 *
 * The harness is always spawned through `process.execPath`, which is the right
 * interpreter in a Node host (the CLI) and the wrong one under Electron: there
 * it is `electron.exe`, so a Node script passed as its argument starts a
 * second GUI app instead. That app never answers the JSON-RPC handshake, so
 * the first brief hangs forever instead of failing. This flag turns the same
 * binary back into the runtime the script expects. Node ignores it.
 */
export const DSH_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";

/** Env var holding an explicit `dsh` entry point. */
export const DSH_BIN_ENV = "DSH_BIN";

/** Env var holding the harness SDK module: a bare module id, or an absolute
 *  path to its entry file. */
export const DSH_SDK_ENV = "DSH_SDK";

/** Bare module id of the harness SDK. */
export const DSH_SDK_MODULE = "@deepseek-ai/dsh-sdk-client";

export interface ResolvedDshSdk {
  /** The specifier to hand to `import()`. */
  readonly module: string;
  /** The absolute path behind `module` when the caller named one; the caller
   *  can check it exists. Absent for a bare module id. */
  readonly path?: string;
}

/**
 * Resolves the harness SDK to import.
 *
 * Default is the bare module id, which is what a Node host (the CLI) can
 * resolve from this package. A BUNDLED host (the Electron GUI) cannot: it
 * inlines its whole dependency graph and ships no `node_modules`, so a bare id
 * would resolve against the bundle's location and miss. Such a host points
 * `DSH_SDK` (or `HERTA_DSH_SDK`) at the SDK's entry file instead — an absolute
 * path is turned into a file URL, which also keeps the SDK's OWN imports
 * resolving inside its install tree rather than against the host's.
 */
export function resolveDshSdk(
  input: {
    readonly sdkPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ResolvedDshSdk {
  const explicit =
    input.sdkPath ?? input.env?.[DSH_SDK_ENV] ?? process.env[DSH_SDK_ENV];
  if (explicit === undefined || explicit.trim().length === 0) {
    return { module: DSH_SDK_MODULE };
  }
  if (!isAbsolute(explicit)) return { module: explicit };
  const path = resolve(explicit);
  return { module: pathToFileURL(path).href, path };
}

/**
 * Resolves the `dsh` entry point to spawn.
 *
 * Order: an explicit path, then `DSH_BIN`, then Node's own resolution from
 * this module. Deliberately NOT a bare `dsh` command: the SDK spawns with
 * `stdio: ['pipe','pipe','pipe']` and speaks newline-delimited JSON-RPC, so a
 * shell shim (a `.cmd` on Windows) would sit between the pipes and the
 * protocol.
 */
export function resolveDshBinPath(input: {
  readonly binPath?: string;
  readonly from?: string;
}): string | null {
  const explicit = input.binPath ?? process.env[DSH_BIN_ENV];
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? resolve(explicit) : null;
  }
  try {
    const require = createRequire(input.from ?? import.meta.url);
    return require.resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    return null;
  }
}

/**
 * Builds the spawn spec for the harness, or `null` when no `dsh` install can
 * be found — the caller reports that as a blocked brief rather than crashing
 * the session.
 */
export function resolveDshLaunch(
  input: ResolveDshLaunchInput,
): DshLaunchOptions | null {
  const binPath = resolveDshBinPath({
    ...(input.binPath === undefined ? {} : { binPath: input.binPath }),
    from: import.meta.url,
  });
  if (binPath === null) return null;

  const env: Record<string, string | undefined> = { ...input.env };
  if (input.apiKey !== undefined && input.apiKey.length > 0) {
    env[DSH_API_KEY_ENV] = input.apiKey;
  }
  if (input.electronMain ?? process.versions.electron !== undefined) {
    env[DSH_RUN_AS_NODE_ENV] = "1";
  }

  return {
    command: process.execPath,
    args: [binPath, "--profile", input.profile ?? DEFAULT_DSH_PROFILE],
    cwd: input.cwd,
    dshHome: resolve(
      input.dshHome ?? resolve(input.home ?? homedir(), ".herta", "dsh-home"),
    ),
    ...(input.personaPrefix === undefined
      ? {}
      : { personaPrefix: input.personaPrefix }),
    env,
    ...(input.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: input.requestTimeoutMs }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}
