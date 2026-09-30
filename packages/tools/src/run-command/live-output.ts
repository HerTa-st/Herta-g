import { redactSecrets } from "./redactor.js";

/** A line longer than this with no newline yet (a `\r` progress bar, a
 *  minified blob) goes out as it stands rather than waiting forever. */
const MAX_PARTIAL_CHARS = 4_096;

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

/**
 * A running command's output on its way to the live view (ADR 0073): whole
 * lines, redacted as the stored output is (`redactSecrets`), handed on a
 * batch at a time. Line by line because the redactor's patterns are line
 * shaped — a token split across two chunks would pass it — and because a
 * terminal tail is read by the line anyway.
 *
 * A private key spans lines, which the whole-text redactor handles with one
 * pattern; here it is a state: from a BEGIN line to its END line, one
 * `[REDACTED:private_key]` stands for the block.
 *
 * Display only. What the model and the record get is the tool's result,
 * which is built from the captured output exactly as before.
 */
export class LiveOutput {
  private partial = "";
  private inKey = false;

  constructor(private readonly emit: (text: string) => void) {}

  /** Text as it arrived; `\r\n` is folded to `\n` here. */
  push(text: string): void {
    if (text.length === 0) return;
    const s = this.partial + text.replace(/\r\n/g, "\n");
    const cut = s.lastIndexOf("\n");
    if (cut === -1) {
      this.partial = s;
      if (this.partial.length > MAX_PARTIAL_CHARS) this.flush();
      return;
    }
    this.partial = s.slice(cut + 1);
    this.send(s.slice(0, cut).split("\n"), true);
    if (this.partial.length > MAX_PARTIAL_CHARS) this.flush();
  }

  /** The last line, when the command ended without a newline. */
  flush(): void {
    if (this.partial.length === 0) return;
    const line = this.partial;
    this.partial = "";
    this.send([line], false);
  }

  private send(lines: readonly string[], terminated: boolean): void {
    const out: string[] = [];
    for (const line of lines) {
      if (this.inKey) {
        if (PEM_END_RE.test(line)) this.inKey = false;
        continue;
      }
      if (PEM_BEGIN_RE.test(line)) {
        out.push("[REDACTED:private_key]");
        if (!PEM_END_RE.test(line)) this.inKey = true;
        continue;
      }
      out.push(redactSecrets(line));
    }
    if (out.length === 0) return;
    this.emit(terminated ? `${out.join("\n")}\n` : out.join("\n"));
  }
}
