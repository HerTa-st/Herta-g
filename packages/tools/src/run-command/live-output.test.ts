import { describe, expect, it } from "vitest";
import { LiveOutput } from "./live-output.js";

function collect(): { out: string[]; live: LiveOutput } {
  const out: string[] = [];
  return { out, live: new LiveOutput((t) => out.push(t)) };
}

describe("LiveOutput (ADR 0073)", () => {
  it("hands on whole lines as they complete, a batch per push; the last partial line on flush", () => {
    const { out, live } = collect();
    live.push("a\nb");
    live.push("c\r\nd\n");
    live.push("e");
    live.flush();
    live.flush();
    expect(out).toEqual(["a\n", "bc\nd\n", "e"]);
  });

  it("redacts as the stored output is redacted — a token split across two chunks is caught whole", () => {
    const { out, live } = collect();
    live.push("export OPENAI_API_KEY=sk-abcdef");
    live.push("ghijklmnopqrstuv\nnext\n");
    expect(out.join("")).toBe(
      "export OPENAI_API_KEY=[REDACTED:env_secret]\nnext\n",
    );
  });

  it("a private key block becomes one marker, however many lines and chunks it spans", () => {
    const { out, live } = collect();
    live.push("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE");
    live.push("xyz\nabc\n-----END RSA PRIVATE KEY-----\nafter\n");
    expect(out.join("")).toBe("before\n[REDACTED:private_key]\nafter\n");
  });

  it("a very long line with no newline goes out as it stands rather than waiting forever", () => {
    const { out, live } = collect();
    live.push("x".repeat(5_000));
    expect(out.join("")).toBe("x".repeat(5_000));
  });
});
