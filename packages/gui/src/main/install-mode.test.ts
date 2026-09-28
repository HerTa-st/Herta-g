import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstallMode } from "./install-mode.js";

describe("the install mode (2026-09-28)", () => {
  it("our own builds: packaged, resources where Electron says", () => {
    expect(
      resolveInstallMode({
        isPackaged: true,
        appPath: "C:\\Program Files\\Herta\\resources\\app.asar",
        resourcesPath: "C:\\Program Files\\Herta\\resources",
      }),
    ).toEqual({
      installed: true,
      resourcesPath: "C:\\Program Files\\Herta\\resources",
    });
  });

  it("our asar on the system's Electron (Arch herta-bin): installed, resources beside the asar", () => {
    // `electron43 /usr/lib/herta-bin/resources/app.asar` — Electron's own
    // answer is false (the binary is called `electron`), and its resources
    // are Electron's, not ours.
    expect(
      resolveInstallMode({
        isPackaged: false,
        appPath: "/usr/lib/herta-bin/resources/app.asar",
        resourcesPath: "/usr/lib/electron43/resources",
      }),
    ).toEqual({
      installed: true,
      resourcesPath: "/usr/lib/herta-bin/resources",
    });
  });

  it("a development run (the package directory): not installed", () => {
    expect(
      resolveInstallMode({
        isPackaged: false,
        appPath: "E:\\HERTA\\packages\\gui",
        resourcesPath:
          "E:\\HERTA\\packages\\gui\\node_modules\\electron\\dist\\resources",
      }),
    ).toEqual({
      installed: false,
      resourcesPath:
        "E:\\HERTA\\packages\\gui\\node_modules\\electron\\dist\\resources",
    });
  });
});

/** The main process's source files, read off disk (vitest runs from the
 *  repo root or the package). */
function mainSources(): { file: string; text: string }[] {
  const rel = "src/main";
  let root: string | undefined;
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) root = p;
  }
  if (root === undefined) throw new Error("src/main not found from cwd");
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|cjs|mjs|js)$/.test(name) && !/\.test\./.test(name)) {
        out.push({
          file: relative(root as string, p).replaceAll("\\", "/"),
          text: readFileSync(p, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}

describe("nothing in main asks Electron directly", () => {
  it("only install-mode.ts reads app.isPackaged or process.resourcesPath", () => {
    // A read elsewhere would put that one path back on Electron's answer —
    // the one a system-Electron package gets wrong.
    const offenders = mainSources()
      .filter((s) => s.file !== "install-mode.ts")
      .flatMap((s) =>
        s.text
          .split("\n")
          .map((line, i) => ({ line, at: `${s.file}:${i + 1}` }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .filter(({ line }) =>
            /\bapp\.isPackaged\b|\bprocess\.resourcesPath\b/.test(line),
          )
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });
});
