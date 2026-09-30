import { describe, expect, it } from "vitest";
import { scanJsonStrings } from "./partial-json.js";

describe("scanJsonStrings", () => {
  it("reads every string value with its key, and not the keys themselves", () => {
    expect(
      scanJsonStrings('{"command":"create","path":"a.ts","file_text":"x"}'),
    ).toEqual([
      { key: "command", value: "create", complete: true },
      { key: "path", value: "a.ts", complete: true },
      { key: "file_text", value: "x", complete: true },
    ]);
  });

  it("is tolerant of a text cut off anywhere — the normal case while arguments stream", () => {
    expect(scanJsonStrings('{"path":"src/a')).toEqual([
      { key: "path", value: "src/a", complete: false },
    ]);
    expect(scanJsonStrings('{"path":"a.ts","file_te')).toEqual([
      { key: "path", value: "a.ts", complete: true },
    ]);
    expect(scanJsonStrings("")).toEqual([]);
    expect(scanJsonStrings("{")).toEqual([]);
  });

  it("decodes escapes, and leaves out one cut off at the end rather than guess", () => {
    expect(
      scanJsonStrings('{"t":"a\\nb\\t\\"q\\" \\\\ \\u4e2d"}')[0]?.value,
    ).toBe('a\nb\t"q" \\ 中');
    expect(scanJsonStrings('{"t":"line\\')[0]).toEqual({
      key: "t",
      value: "line",
      complete: false,
    });
    expect(scanJsonStrings('{"t":"x\\u4e')[0]?.value).toBe("x");
  });

  it("an array's elements carry the array's key; nested objects their own", () => {
    expect(
      scanJsonStrings(
        '{"path":"a.ts","hunks":[{"search":"old","replace":"new"},{"search":"o2","replace":"n',
      ),
    ).toEqual([
      { key: "path", value: "a.ts", complete: true },
      { key: "search", value: "old", complete: true },
      { key: "replace", value: "new", complete: true },
      { key: "search", value: "o2", complete: true },
      { key: "replace", value: "n", complete: false },
    ]);
    expect(
      scanJsonStrings('{"argv":["npm","test"],"cwd":"."}').map((f) => f.key),
    ).toEqual(["argv", "argv", "cwd"]);
  });

  it("a brace or quote inside a string value is text, not structure", () => {
    expect(
      scanJsonStrings('{"file_text":"if (a) { b(\\"}\\"); }","path":"x.ts"}'),
    ).toEqual([
      { key: "file_text", value: 'if (a) { b("}"); }', complete: true },
      { key: "path", value: "x.ts", complete: true },
    ]);
  });
});
