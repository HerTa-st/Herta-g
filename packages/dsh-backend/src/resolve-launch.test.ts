import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DSH_PROFILE,
  DSH_API_KEY_ENV,
  DSH_RUN_AS_NODE_ENV,
  resolveDshBinPath,
  resolveDshLaunch,
} from "./resolve-launch.js";

/** A path that is guaranteed to exist on any host running these tests. */
const REAL_BIN = process.execPath;

function withEnv(value: string | undefined, body: () => void): void {
  const previous = process.env.DSH_BIN;
  if (value === undefined) delete process.env.DSH_BIN;
  else process.env.DSH_BIN = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previous;
  }
}

describe("resolveDshBinPath", () => {
  it("prefers an explicit path over the environment", () => {
    withEnv("C:/does/not/exist.js", () => {
      expect(resolveDshBinPath({ binPath: REAL_BIN })).toBe(REAL_BIN);
    });
  });

  it("rejects an explicit path that does not exist", () => {
    // Better to report "no harness installed" than to spawn a path that will
    // fail with an opaque ENOENT inside the SDK.
    expect(resolveDshBinPath({ binPath: "C:/nope/bin.js" })).toBeNull();
  });

  it("falls back to DSH_BIN", () => {
    withEnv(REAL_BIN, () => {
      expect(resolveDshBinPath({})).toBe(REAL_BIN);
    });
  });

  it("ignores an empty DSH_BIN", () => {
    withEnv("", () => {
      const resolved = resolveDshBinPath({ from: "file:///nope/index.js" });
      expect(resolved).toBeNull();
    });
  });

  it("returns null when nothing resolves", () => {
    withEnv(undefined, () => {
      expect(resolveDshBinPath({ from: "file:///nope/index.js" })).toBeNull();
    });
  });
});

describe("resolveDshLaunch", () => {
  it("reports no launch when no install is resolvable", () => {
    withEnv(undefined, () => {
      expect(resolveDshLaunch({ cwd: "C:/ws" })).toBeNull();
    });
  });

  it("spawns node with the bin path and the default profile", () => {
    const launch = resolveDshLaunch({ cwd: "C:/ws", binPath: REAL_BIN });

    expect(launch?.command).toBe(process.execPath);
    expect(launch?.args).toEqual([REAL_BIN, "--profile", DEFAULT_DSH_PROFILE]);
    expect(launch?.cwd).toBe("C:/ws");
  });

  it("keeps Herta's DSH home out of the workspace and out of the install tree", () => {
    // A home inside either the install tree or the project would either let
    // the harness pick up a second, incompatible copy of dsh-tools, or make
    // the operator recreate the profile in every project they touch. It is
    // machine-level state, so it lives beside the user's other `.herta` data.
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      home: "C:/Users/me",
    });
    expect(launch?.dshHome).toBe(resolve("C:/Users/me", ".herta", "dsh-home"));
    expect(launch?.dshHome).not.toContain("C:/ws");
  });

  it("does not move the home when the workspace changes", () => {
    const first = resolveDshLaunch({
      cwd: "C:/ws/a",
      binPath: REAL_BIN,
      home: "C:/Users/me",
    });
    const second = resolveDshLaunch({
      cwd: "C:/ws/b",
      binPath: REAL_BIN,
      home: "C:/Users/me",
    });
    expect(first?.dshHome).toBe(second?.dshHome);
  });

  it("honours an explicit home and profile", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      dshHome: "C:/homes/herta",
      profile: "herta-dsh",
    });

    expect(launch?.args).toEqual([REAL_BIN, "--profile", "herta-dsh"]);
    expect(launch?.dshHome).toBe(resolve("C:/homes/herta"));
  });

  it("never puts the credential on the command line", () => {
    // argv is world-readable on most hosts; the key travels in env only.
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      apiKey: "sk-secret",
    });

    expect(launch?.args.join(" ")).not.toContain("sk-secret");
    expect(launch?.env?.[DSH_API_KEY_ENV]).toBe("sk-secret");
  });

  it("omits the credential key entirely when none is configured", () => {
    const launch = resolveDshLaunch({ cwd: "C:/ws", binPath: REAL_BIN });
    expect(launch?.env).not.toHaveProperty(DSH_API_KEY_ENV);
  });

  it("passes through extra env, including explicit undefined", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      env: { DSH_LOG: "debug", DROP: undefined },
    });

    expect(launch?.env).toEqual({ DSH_LOG: "debug", DROP: undefined });
  });

  it("carries the persona and the session route", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      personaPrefix: "你是黑塔。",
      requestTimeoutMs: 12_345,
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });

    expect(launch?.personaPrefix).toBe("你是黑塔。");
    expect(launch?.requestTimeoutMs).toBe(12_345);
    expect(launch?.provider).toBe("deepseek-official");
    expect(launch?.model).toBe("deepseek-v4-pro");
  });

  it("resolves a relative home against the process cwd, not the workspace", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      dshHome: "rel/home",
    });
    expect(launch?.dshHome).not.toContain("C:/ws/rel");
    expect(
      launch?.dshHome?.endsWith("rel\\home") ||
        launch?.dshHome?.endsWith("rel/home"),
    ).toBe(true);
  });
});

describe("resolveDshLaunch under Electron", () => {
  it("turns the interpreter back into Node when Electron owns execPath", () => {
    // The harness is spawned through `process.execPath`. In an Electron main
    // process that is `electron.exe`, so the bin path is treated as an app to
    // launch rather than a script to run: Electron boots a second GUI app,
    // which never answers the JSON-RPC handshake and hangs the first brief.
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      electronMain: true,
    });

    expect(launch?.command).toBe(process.execPath);
    expect(launch?.env?.[DSH_RUN_AS_NODE_ENV]).toBe("1");
  });

  it("leaves a Node host alone", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      electronMain: false,
    });

    expect(launch?.env).not.toHaveProperty(DSH_RUN_AS_NODE_ENV);
  });

  it("defaults to asking the runtime whether it is Electron", () => {
    // These tests run under plain Node, so the default must not set the flag —
    // and, just as importantly, must not set it unconditionally either.
    const launch = resolveDshLaunch({ cwd: "C:/ws", binPath: REAL_BIN });

    if (process.versions.electron === undefined) {
      expect(launch?.env).not.toHaveProperty(DSH_RUN_AS_NODE_ENV);
    } else {
      expect(launch?.env?.[DSH_RUN_AS_NODE_ENV]).toBe("1");
    }
  });

  it("lets an explicit value win over the ambient one", () => {
    const launch = resolveDshLaunch({
      cwd: "C:/ws",
      binPath: REAL_BIN,
      electronMain: true,
      env: { [DSH_RUN_AS_NODE_ENV]: "0" },
    });

    expect(launch?.env?.[DSH_RUN_AS_NODE_ENV]).toBe("1");
  });
});

describe("resolveDshLaunch integration with the environment", () => {
  it("resolves through DSH_BIN like the real launcher would", () => {
    withEnv(REAL_BIN, () => {
      expect(resolveDshLaunch({ cwd: "C:/ws" })?.args[0]).toBe(REAL_BIN);
    });
  });

  it("prefers an explicit binPath over DSH_BIN", () => {
    withEnv("C:/ignored/bin.js", () => {
      expect(
        resolveDshLaunch({ cwd: "C:/ws", binPath: REAL_BIN })?.args[0],
      ).toBe(REAL_BIN);
    });
  });
});
