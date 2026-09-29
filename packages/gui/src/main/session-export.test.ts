import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExportSaver,
  type ExportSaverDeps,
  exportFileName,
  MAX_EXPORT_CHARS,
} from "./session-export.js";

describe("exportFileName (ADR 0072 §3)", () => {
  it("is the title with .md", () => {
    expect(exportFileName("排查解析报错")).toBe("排查解析报错.md");
  });

  it("turns what no file system takes into spaces, and collapses them", () => {
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a b c d e f g h i j.md",
    );
    expect(exportFileName("第一行\n第二行\t尾")).toBe("第一行 第二行 尾.md");
  });

  it("drops leading and trailing dots and spaces (Windows drops them silently)", () => {
    expect(exportFileName("  ..名字.. ")).toBe("名字.md");
  });

  it("gives a Windows device name a suffix", () => {
    expect(exportFileName("CON")).toBe("CON_.md");
    expect(exportFileName("lpt1")).toBe("lpt1_.md");
  });

  it("caps the stem, and falls back when nothing is left", () => {
    expect([...exportFileName("名".repeat(200)).slice(0, -3)]).toHaveLength(80);
    expect(exportFileName("")).toBe("Herta.md");
    expect(exportFileName("///")).toBe("Herta.md");
  });
});

function fakeDeps(over: Partial<ExportSaverDeps> = {}): {
  deps: ExportSaverDeps;
  offered: string[];
  written: Array<[string, string]>;
  logged: string[];
} {
  const offered: string[] = [];
  const written: Array<[string, string]> = [];
  const logged: string[] = [];
  return {
    offered,
    written,
    logged,
    deps: {
      showSaveDialog: async (opts) => {
        offered.push(opts.defaultPath);
        return { canceled: false, filePath: join("D:", "exports", "a.md") };
      },
      documentsDir: () => join("C:", "Docs"),
      writeFile: async (path, data) => {
        written.push([path, data]);
      },
      log: (line) => logged.push(line),
      ...over,
    },
  };
}

describe("createExportSaver (ADR 0072 §3)", () => {
  it("offers Documents first, writes the pick, then offers the pick's folder", async () => {
    const f = fakeDeps();
    const save = createExportSaver(f.deps);

    expect(await save("我的会话", "# 我的会话\n")).toEqual({ saved: true });
    expect(await save("第二个", "# 第二个\n")).toEqual({ saved: true });

    expect(f.offered).toEqual([
      join("C:", "Docs", "我的会话.md"),
      join("D:", "exports", "第二个.md"),
    ]);
    expect(f.written).toEqual([
      [join("D:", "exports", "a.md"), "# 我的会话\n"],
      [join("D:", "exports", "a.md"), "# 第二个\n"],
    ]);
    // The log never carries the path or the title.
    expect(f.logged).toEqual([
      "[herta] export: saved",
      "[herta] export: saved",
    ]);
  });

  it("writes nothing when the dialog is cancelled", async () => {
    const f = fakeDeps({ showSaveDialog: async () => ({ canceled: true }) });
    expect(await createExportSaver(f.deps)("x", "y")).toEqual({ saved: false });
    expect(f.written).toEqual([]);
  });

  it("says a failed write failed, naming the error code only", async () => {
    const f = fakeDeps({
      writeFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(await createExportSaver(f.deps)("x", "y")).toEqual({
      saved: false,
      failed: true,
    });
    expect(f.logged).toEqual(["[herta] export: the write failed (EACCES)"]);
  });

  it("refuses what is not text, or too much of it, without a dialog", async () => {
    const f = fakeDeps({ maxChars: 10 });
    const save = createExportSaver(f.deps);
    expect(await save(1, "y")).toEqual({ saved: false, failed: true });
    expect(await save("x", { md: 1 })).toEqual({ saved: false, failed: true });
    expect(await save("x", "a".repeat(11))).toEqual({
      saved: false,
      failed: true,
    });
    expect(f.offered).toEqual([]);
    // The real bound: a long session's export is a few megabytes.
    expect(MAX_EXPORT_CHARS).toBe(64 * 1024 * 1024);
  });
});
