import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  osLocale,
  readGlobalSettings,
  resolveInitialLocale,
  resolveInteractionLang,
  updateGlobalSettings,
  writeGlobalSettings,
} from "./app-global-settings.js";

const created: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-global-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("app-global-settings", () => {
  it("returns {} for a missing file", async () => {
    expect(await readGlobalSettings(tmp())).toEqual({});
  });

  it("returns {} for a corrupt / invalid-shape file", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { locale: "en" });
    writeFileSync(join(dir, "settings.json"), '{"locale":5}', "utf-8");
    expect(await readGlobalSettings(dir)).toEqual({});
  });

  it("round-trips locale and preserves other keys", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { locale: "zh" });
    expect(await readGlobalSettings(dir)).toEqual({ locale: "zh" });
    const raw = readFileSync(join(dir, "settings.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("resolveInitialLocale: stored wins, else OS zh*->zh else en", () => {
    expect(resolveInitialLocale({ locale: "en" }, "zh-CN")).toBe("en");
    expect(resolveInitialLocale({}, "zh-CN")).toBe("zh");
    expect(resolveInitialLocale({}, "en-US")).toBe("en");
    expect(resolveInitialLocale({}, "fr-FR")).toBe("en");
  });

  it("osLocale: a Chinese Mac reads its own language list, not the bundle-limited Chromium locale (2026-09-23)", () => {
    // What a Chinese Mac answered while the packaged app carried en.lproj
    // only: Chromium said `en-US`, the user's list said Chinese.
    const chineseMac = {
      getLocale: () => "en-US",
      getPreferredSystemLanguages: () => ["zh-Hans-CN", "en-CN"],
    };
    expect(osLocale("darwin", chineseMac)).toBe("zh-Hans-CN");
    expect(resolveInitialLocale({}, osLocale("darwin", chineseMac))).toBe("zh");
    // An empty list falls back to Chromium's answer.
    expect(
      osLocale("darwin", {
        getLocale: () => "zh-CN",
        getPreferredSystemLanguages: () => [],
      }),
    ).toBe("zh-CN");
  });

  it("osLocale: Windows and Linux keep Chromium's locale, which already follows the OS", () => {
    const src = {
      getLocale: () => "zh-CN",
      getPreferredSystemLanguages: () => ["en-US"],
    };
    expect(osLocale("win32", src)).toBe("zh-CN");
    expect(osLocale("linux", src)).toBe("zh-CN");
  });

  it("round-trips closeToTray alongside locale (Settings → Window)", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { locale: "zh", closeToTray: false });
    expect(await readGlobalSettings(dir)).toEqual({
      locale: "zh",
      closeToTray: false,
    });
  });

  it("returns {} when closeToTray is not a boolean", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "settings.json"), '{"closeToTray":"yes"}', "utf-8");
    expect(await readGlobalSettings(dir)).toEqual({});
  });

  it("round-trips the attention flags and refuses a non-boolean one (ADR 0072 §1)", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { notifications: false, keepAwake: true });
    expect(await readGlobalSettings(dir)).toEqual({
      notifications: false,
      keepAwake: true,
    });
    writeFileSync(join(dir, "settings.json"), '{"keepAwake":"on"}', "utf-8");
    expect(await readGlobalSettings(dir)).toEqual({});
  });

  it("round-trips theme and rejects invalid values (night-mode slice 2)", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { theme: "dark" });
    expect(await readGlobalSettings(dir)).toEqual({ theme: "dark" });
    // The retired 3D device toggle (ADR 0057 §2.7, amended 2026-10-01): a
    // file that still carries it — in any shape — keeps every other setting.
    writeFileSync(
      join(dir, "settings.json"),
      '{"theme":"dark","deviceScene":"yes"}',
      "utf-8",
    );
    expect(await readGlobalSettings(dir)).toMatchObject({ theme: "dark" });
    await writeGlobalSettings(dir, { theme: "system" });
    expect(await readGlobalSettings(dir)).toEqual({ theme: "system" });
    writeFileSync(join(dir, "settings.json"), '{"theme":"neon"}', "utf-8");
    expect(await readGlobalSettings(dir)).toEqual({});
  });

  it("round-trips interactionLanguage and rejects invalid values (slice 4)", async () => {
    const dir = tmp();
    await writeGlobalSettings(dir, { interactionLanguage: "en" });
    expect(await readGlobalSettings(dir)).toEqual({
      interactionLanguage: "en",
    });
    await writeGlobalSettings(dir, { interactionLanguage: "zh" });
    expect(await readGlobalSettings(dir)).toEqual({
      interactionLanguage: "zh",
    });
    // Off-enum value → whole file rejected (same shape guard as theme).
    writeFileSync(
      join(dir, "settings.json"),
      '{"interactionLanguage":"fr"}',
      "utf-8",
    );
    expect(await readGlobalSettings(dir)).toEqual({});
  });

  it("resolveInteractionLang: stored wins, else follow the UI locale", () => {
    // Explicit choice wins over any locale.
    expect(resolveInteractionLang({ interactionLanguage: "en" }, "zh")).toBe(
      "en",
    );
    expect(resolveInteractionLang({ interactionLanguage: "zh" }, "en")).toBe(
      "zh",
    );
    // Absent ("follow"): zh locale → zh, everything else → en.
    expect(resolveInteractionLang({}, "zh")).toBe("zh");
    expect(resolveInteractionLang({}, "en")).toBe("en");
    // The UI locale does NOT bleed through an explicit choice even when the
    // locale itself was stored.
    expect(
      resolveInteractionLang({ locale: "zh", interactionLanguage: "en" }, "zh"),
    ).toBe("en");
  });

  it("updateGlobalSettings serializes concurrent RMW cycles (audit T1.4)", async () => {
    const dir = tmp();
    // Unserialized, all four read {} concurrently and the last write wins —
    // exactly the theme-toggle-during-window-drag lost-field bug.
    await Promise.all([
      updateGlobalSettings(dir, (s) => ({ ...s, locale: "zh" as const })),
      updateGlobalSettings(dir, (s) => ({ ...s, theme: "dark" as const })),
      updateGlobalSettings(dir, (s) => ({ ...s, closeToTray: false })),
      updateGlobalSettings(dir, (s) => ({ ...s, autoUpdate: false })),
    ]);
    expect(await readGlobalSettings(dir)).toEqual({
      locale: "zh",
      theme: "dark",
      closeToTray: false,
      autoUpdate: false,
    });
    // Temp+rename leaves no residue (audit T3.9 atomic write).
    expect(existsSync(join(dir, "settings.json.tmp"))).toBe(false);
  });

  it("a failed update rejects its caller but never wedges the chain", async () => {
    const dir = tmp();
    await expect(
      updateGlobalSettings(dir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await updateGlobalSettings(dir, (s) => ({ ...s, locale: "en" as const }));
    expect(await readGlobalSettings(dir)).toEqual({ locale: "en" });
  });

  it("round-trips windowState and rejects malformed shapes (2026-07-13)", async () => {
    const dir = tmp();
    const windowState = {
      x: 100,
      y: 50,
      width: 1600,
      height: 1000,
      maximized: true,
      fullScreen: false,
    };
    await writeGlobalSettings(dir, { windowState });
    expect(await readGlobalSettings(dir)).toEqual({ windowState });
    // Positionless is valid (x/y optional).
    const sizeOnly = {
      width: 1440,
      height: 900,
      maximized: false,
      fullScreen: true,
    };
    await writeGlobalSettings(dir, { windowState: sizeOnly });
    expect(await readGlobalSettings(dir)).toEqual({ windowState: sizeOnly });
    // Malformed: non-numeric width / missing booleans → whole file rejected.
    writeFileSync(
      join(dir, "settings.json"),
      '{"windowState":{"width":"wide","height":900,"maximized":false,"fullScreen":false}}',
      "utf-8",
    );
    expect(await readGlobalSettings(dir)).toEqual({});
    writeFileSync(
      join(dir, "settings.json"),
      '{"windowState":{"width":1600,"height":1000}}',
      "utf-8",
    );
    expect(await readGlobalSettings(dir)).toEqual({});
  });
});
