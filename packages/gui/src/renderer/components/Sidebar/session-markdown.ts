import type { SessionExportSource } from "@herta/app-server";
import { makeT, type TFn } from "../../i18n/LocaleProvider.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import { aliasBanzhuanPlain } from "../../lib/banzhuan-mention.js";
import {
  activityChipLabel,
  activityRows,
  activitySummary,
  groupRecord,
  type SystemBlock,
} from "../Workspace/group-record.js";
import { composeMarkerSummary } from "../Workspace/marker-summary.js";
import { stepDisplayBody } from "../Workspace/step-display.js";

/**
 * A session as Markdown (ADR 0072 §3): what the window shows, in the
 * session's own language.
 *
 * - The user's words and Herta's speech, whole — her code blocks included.
 *   The copy button leaves code out because a clipboard of pasted code
 *   invites pasting it back; an export is a record of the session and drops
 *   nothing she said.
 * - Each run of system blocks as a quote: the header the window shows (who
 *   worked, and the done marker's summary), then one line per row. A row is
 *   its first line, worded as the window words it; the diffs, output tails
 *   and excerpts behind the expanders stay out (the source record does not
 *   even carry the evidence sections — `exportRecord`).
 * - Never Herta's thoughts, never the prompt format.
 *
 * `now` and `timeZone` are injected so the output is deterministic.
 */
export function buildSessionMarkdown(
  src: SessionExportSource,
  t: TFn,
  opts: { readonly now: Date; readonly timeZone?: string },
): string {
  const out: string[] = [];
  const stamp = (iso: string): string => formatStamp(iso, opts.timeZone);
  const title =
    src.title !== null && src.title !== "" ? src.title : t("session.untitled");
  out.push(`# ${title.replace(/\s+/g, " ").trim()}`);
  const firstAt = src.record.find((b) => b.at !== undefined)?.at;
  const meta = [
    ...(firstAt !== undefined
      ? [t("export.startedAt", { time: stamp(firstAt) })]
      : []),
    t("export.exportedAt", { time: stamp(opts.now.toISOString()) }),
  ];
  out.push(meta.join(" · "));

  for (const item of groupRecord(src.record)) {
    if (item.kind === "activity") {
      out.push(activityQuote(item.blocks, t));
      continue;
    }
    const b = item.block;
    if (b.kind === "system") continue; // groupRecord never passes one through
    if (b.kind === "herta" && b.surface !== "speech") continue;
    const text = aliasBanzhuanPlain(b.text, src.lang).trim();
    if (text === "") continue;
    const who = t(b.kind === "user" ? "export.user" : "export.herta");
    const when = b.at !== undefined ? ` · ${stamp(b.at)}` : "";
    out.push(`**${who}**${when}\n\n${text}`);
  }
  return `${out.join("\n\n")}\n`;
}

/** One run of system blocks: its header, then a line per row. */
function activityQuote(blocks: readonly SystemBlock[], t: TFn): string {
  const chip = t(
    activityChipLabel(blocks) === "差分协处理器"
      ? "record.chip.coprocessor"
      : "record.chip.system",
  );
  const summary = activitySummary(blocks);
  let head = `**${chip}**`;
  if (summary !== null) {
    // The window shows the run's `+N −M` as its own element beside the
    // summary; here it is text, in the canonical body's place.
    head += ` · ${composeMarkerSummary(summary, t, { withLines: true })}`;
  }
  const lines = [head];
  for (const row of activityRows(blocks)) {
    let line = firstLine(stepDisplayBody(row.block, t));
    const p = row.patch?.digest;
    if (p?.kind === "patch" && p.add !== undefined && p.del !== undefined) {
      line += ` · ${magnitude(p.add, p.del)}`;
    }
    if (line !== "") lines.push(`- ${line}`);
  }
  return lines.map((l) => `> ${l}`).join("\n");
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return (nl >= 0 ? text.slice(0, nl) : text).trim();
}

function magnitude(add: number, del: number): string {
  return `+${add} −${del}`;
}

/** `2026-09-29 14:03`, in `timeZone` (the machine's by default). */
export function formatStamp(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** How an export ended, for the card's brief notice. */
export type ExportOutcome = "saved" | "cancelled" | "failed";

/**
 * Export one session: read it (main), write the Markdown in the session's
 * own language (here, where the row wording lives), save it (main's dialog).
 * Null when the bridge lacks the surface.
 */
export async function runSessionExport(
  bridge: Pick<HertaBridge, "readSessionForExport" | "saveSessionExport">,
  sessionId: string,
  now: () => Date = () => new Date(),
): Promise<ExportOutcome | null> {
  const read = bridge.readSessionForExport;
  const save = bridge.saveSessionExport;
  if (read === undefined || save === undefined) return null;
  try {
    const src = await read(sessionId);
    if (src === null) return "failed";
    const t = makeT(src.lang);
    const markdown = buildSessionMarkdown(src, t, { now: now() });
    const name =
      src.title !== null && src.title !== ""
        ? src.title
        : t("session.untitled");
    const r = await save(name, markdown);
    return r.saved ? "saved" : r.failed === true ? "failed" : "cancelled";
  } catch {
    return "failed";
  }
}
