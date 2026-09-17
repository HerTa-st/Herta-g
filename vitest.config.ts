import { defineConfig } from "vitest/config";
import { DOM_FREE_TESTS } from "./packages/gui/vitest.dom-free.js";

// Workspace vitest config — uses Vitest 3's `projects` feature so each
// package can opt into its own environment / setup files. Without
// projects, every test would inherit the root environment (node) and
// the root setupFiles (none), which breaks React/jsdom tests in
// packages/gui.
export default defineConfig({
  test: {
    projects: [
      // Default project: all non-gui packages. Node environment,
      // .test.ts only (no React / JSX in these packages).
      {
        test: {
          name: "node",
          include: [
            "packages/{app-server,cli,core,dsh-backend,herta,knowledge,memory,providers,tools}/src/**/*.test.ts",
          ],
          passWithNoTests: true,
        },
      },
      // GUI project: defers to packages/gui/vitest.config.ts which
      // sets environment: "jsdom" + setupFiles for jest-dom matchers.
      // Picks up .test.ts and .test.tsx, MINUS the dom-free list below
      // (that config excludes exactly what this one includes).
      "packages/gui",
      // GUI tests that need no DOM (2026-08-27): node environment, no setup
      // file. Two thirds of the suite's work was building a jsdom per file,
      // much of it for files that never read one — see vitest.dom-free.ts for
      // the measurements and why the list is opt-IN.
      {
        test: {
          name: "gui-node",
          include: [
            ...DOM_FREE_TESTS.map((p) => `packages/gui/${p}`),
            // The guard for the split itself. Lives at src/ so the jsdom
            // project's include patterns miss it; named here so it runs.
            "packages/gui/src/vitest-dom-free.test.ts",
          ],
        },
      },
      // Website project (audit T3.7): the demo lives OUTSIDE packages/, so
      // it was invisible to the runner and any test written there silently
      // never ran (masked by passWithNoTests). No tests exist yet; this
      // entry makes future ones actually execute.
      {
        test: {
          name: "website",
          include: ["website/src/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
    passWithNoTests: true,
  },
});
