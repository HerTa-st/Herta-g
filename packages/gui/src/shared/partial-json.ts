/**
 * One string value found in a JSON text that may be cut off anywhere (ADR
 * 0073): a tool call's arguments as the model is still writing them.
 */
export interface JsonStringField {
  /** The object key the string is the value of — for an element of an
   *  array, the array's own key (`argv`, `hunks[].replace` → `replace`).
   *  Null at the top level or under a keyless container. */
  readonly key: string | null;
  /** Decoded so far. An escape cut off at the end is left out, never
   *  guessed. */
  readonly value: string;
  /** The closing quote has arrived. */
  readonly complete: boolean;
}

interface Frame {
  readonly kind: "object" | "array";
  /** The key this container is the value of (inherited by an array's
   *  elements). */
  readonly key: string | null;
  /** Object only: the next string is a key. */
  expectKey: boolean;
  /** Object only: the key whose value comes next. */
  lastKey: string | null;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Every string VALUE in `text`, in order, with the key it belongs to —
 * tolerant of a text cut off mid-token, which is the normal case while the
 * arguments stream. Keys themselves are not reported. One pass, no
 * backtracking: fit to re-run on each throttled frame of a growing buffer.
 *
 * Not a validator. Malformed input yields whatever strings could be read;
 * the finished call is parsed properly elsewhere, and this only feeds a
 * live view.
 */
export function scanJsonStrings(text: string): JsonStringField[] {
  const out: JsonStringField[] = [];
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      // Read one string, decoding as we go.
      let value = "";
      let complete = false;
      let j = i + 1;
      while (j < n) {
        const d = text[j] as string;
        if (d === '"') {
          complete = true;
          j += 1;
          break;
        }
        if (d === "\\") {
          const e = text[j + 1];
          if (e === undefined) {
            j = n; // escape cut off: stop before it
            break;
          }
          if (e === "u") {
            const hex = text.slice(j + 2, j + 6);
            if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              j = n;
              break;
            }
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          value += SIMPLE_ESCAPES[e] ?? e;
          j += 2;
          continue;
        }
        value += d;
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.expectKey) {
        top.lastKey = value;
      } else {
        const key =
          top === undefined
            ? null
            : top.kind === "object"
              ? top.lastKey
              : top.key;
        out.push({ key, value, complete });
      }
      i = j;
      continue;
    }
    if (c === "{" || c === "[") {
      const top = stack[stack.length - 1];
      const key =
        top === undefined
          ? null
          : top.kind === "object"
            ? top.lastKey
            : top.key;
      stack.push({
        kind: c === "{" ? "object" : "array",
        key,
        expectKey: c === "{",
        lastKey: null,
      });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ":") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.expectKey = false;
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.expectKey = true;
    }
    i += 1;
  }
  return out;
}
