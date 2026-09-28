import { dirname } from "node:path";
import { app } from "electron";

/**
 * Whether this process is an INSTALLED app, and where its resources are
 * (2026-09-28). The one place main asks; nothing else reads
 * `app.isPackaged` or `process.resourcesPath` (install-mode.test.ts holds
 * that).
 *
 * `app.isPackaged` alone is Electron's answer, and Electron keys it on the
 * executable's NAME. A distribution package that runs our `app.asar` on
 * the system's Electron — Arch's `herta-bin`: `electron43 …/app.asar` —
 * runs a binary called `electron`, gets `false`, and with it every
 * development path: the workspace (transcripts, memory, the dream) in the
 * process cwd, which is the root-owned install dir; the voice clips looked
 * up in a repository layout; the development CSP; the environment
 * overrides that are never honored installed (the renderer URL, the
 * DeepSeek base URL, the update feed); DevTools in the menu.
 *
 * A run from an asar is an installed app: development runs from the
 * package directory, never an asar. Its resources are the asar's own
 * directory — `process.resourcesPath` in our builds, and the package's
 * resources dir under a system Electron, where `process.resourcesPath` is
 * Electron's own.
 */
export interface InstallMode {
  readonly installed: boolean;
  readonly resourcesPath: string;
}

/** Pure, for tests: the mode from Electron's three facts. */
export function resolveInstallMode(facts: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}): InstallMode {
  if (facts.isPackaged) {
    return { installed: true, resourcesPath: facts.resourcesPath };
  }
  if (/\.asar$/i.test(facts.appPath)) {
    return { installed: true, resourcesPath: dirname(facts.appPath) };
  }
  return { installed: false, resourcesPath: facts.resourcesPath };
}

let mode: InstallMode | null = null;

/** This process's mode, read once. */
export function installMode(): InstallMode {
  mode ??= resolveInstallMode({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  return mode;
}
