import type { SessionExportSource, TerminalRecord } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { makeT } from "../../i18n/LocaleProvider.js";
import {
  buildSessionMarkdown,
  formatStamp,
  runSessionExport,
} from "./session-markdown.js";

const NOW = new Date("2026-09-29T08:00:00.000Z");
const opts = { now: NOW, timeZone: "UTC" };

const record: TerminalRecord = [
  { kind: "user", text: "@板砖 修一下 parser", at: "2026-09-29T06:03:00.000Z" },
  { kind: "herta", surface: "thought", text: "（不该出现的念头）" },
  {
    kind: "herta",
    surface: "speech",
    text: "交给板砖了。\n\n```ts\nconst a = 1;\n```",
    at: "2026-09-29T06:03:20.000Z",
  },
  {
    kind: "system",
    label: "差分协处理器",
    body: "Reading src/parser.ts",
    digest: { kind: "op", verb: "Reading", arg: "src/parser.ts" },
  },
  {
    kind: "system",
    label: "差分协处理器",
    body: "patch preview: src/parser.ts\n```diff\n-a\n+b\n```",
    digest: { kind: "patch", files: ["src/parser.ts"], add: 3, del: 1 },
  },
  {
    kind: "system",
    label: "差分协处理器",
    body: "Writing src/parser.ts",
    digest: { kind: "op", verb: "Writing", arg: "src/parser.ts" },
  },
  {
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 个文件 · +3 −1",
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: 1,
      riskCount: 0,
      lines: { add: 3, del: 1 },
    },
  },
  { kind: "herta", surface: "speech", text: "改好了。" },
];

const src = (over: Partial<SessionExportSource> = {}): SessionExportSource => ({
  sessionId: "s1",
  title: "修 parser",
  lang: "zh",
  record,
  ...over,
});

describe("buildSessionMarkdown (ADR 0072 §3)", () => {
  it("writes the session as the window shows it", () => {
    expect(buildSessionMarkdown(src(), makeT("zh"), opts)).toBe(
      [
        "# 修 parser",
        "",
        "开始于 2026-09-29 06:03 · 导出于 2026-09-29 08:00",
        "",
        "**开拓者** · 2026-09-29 06:03",
        "",
        "@板砖 修一下 parser",
        "",
        "**黑塔** · 2026-09-29 06:03",
        "",
        "交给板砖了。\n\n```ts\nconst a = 1;\n```",
        "",
        "> **差分协处理器** · 完成 · 1 个文件 · +3 −1",
        "> - 读取 src/parser.ts",
        "> - 写入 src/parser.ts · +3 −1",
        "",
        "**黑塔**",
        "",
        "改好了。",
        "",
      ].join("\n"),
    );
  });

  it("never carries a thought, nor the diff behind a row", () => {
    const md = buildSessionMarkdown(src(), makeT("zh"), opts);
    expect(md).not.toContain("不该出现");
    expect(md).not.toContain("```diff");
  });

  it("speaks the session's language: an EN session reads Brick and English rows", () => {
    const md = buildSessionMarkdown(src({ lang: "en" }), makeT("en"), opts);
    expect(md).toContain(
      "**Trailblazer** · 2026-09-29 06:03\n\n@Brick 修一下 parser",
    );
    expect(md).toContain("> **Coprocessor** · Done · 1 file · +3 −1");
    expect(md).toContain("> - Reading src/parser.ts");
    expect(md).toContain(
      "Started 2026-09-29 06:03 · Exported 2026-09-29 08:00",
    );
  });

  it("names an untitled session as the sidebar does, and a session with no stamps by its export alone", () => {
    const md = buildSessionMarkdown(
      src({ title: null, record: [{ kind: "user", text: "hi" }] }),
      makeT("zh"),
      opts,
    );
    expect(md).toBe(
      "# 未命名\n\n导出于 2026-09-29 08:00\n\n**开拓者**\n\nhi\n",
    );
  });
});

describe("formatStamp", () => {
  it("is date and 24-hour time", () => {
    expect(formatStamp("2026-09-29T21:05:00.000Z", "UTC")).toBe(
      "2026-09-29 21:05",
    );
    expect(formatStamp("2026-09-29T00:05:00.000Z", "UTC")).toBe(
      "2026-09-29 00:05",
    );
  });
});

describe("runSessionExport", () => {
  it("reads, writes the Markdown in the session's language, and saves under its title", async () => {
    const saved: Array<[string, string]> = [];
    const r = await runSessionExport(
      {
        readSessionForExport: async () => src({ lang: "en", title: null }),
        saveSessionExport: async (name, markdown) => {
          saved.push([name, markdown]);
          return { saved: true };
        },
      },
      "s1",
      () => NOW,
    );
    expect(r).toBe("saved");
    expect(saved[0]?.[0]).toBe("Untitled");
    expect(saved[0]?.[1]).toContain("**Trailblazer**");
  });

  it("tells a cancel from a failure", async () => {
    const read = async () => src();
    expect(
      await runSessionExport(
        {
          readSessionForExport: read,
          saveSessionExport: async () => ({ saved: false }),
        },
        "s1",
      ),
    ).toBe("cancelled");
    expect(
      await runSessionExport(
        {
          readSessionForExport: read,
          saveSessionExport: async () => ({ saved: false, failed: true }),
        },
        "s1",
      ),
    ).toBe("failed");
    expect(
      await runSessionExport(
        {
          readSessionForExport: async () => null,
          saveSessionExport: async () => ({ saved: true }),
        },
        "s1",
      ),
    ).toBe("failed");
    expect(await runSessionExport({}, "s1")).toBeNull();
  });
});
