import type { SystemBlock, TerminalRecordBlock } from "@herta/core";
import {
  digestSystemBlock,
  foldedRunLine,
  systemRowForHerta,
} from "@herta/herta";

/** Language of the rows' notes: the dream pass's own (ADR 0079 §3). */
type DigestLang = "zh" | "en";

/**
 * One of 板砖's rows as the dream reads it: the same words Herta read it in
 * (ADR 0079 §3, `record-voice.ts`), so the 废案 a dream writes retells the
 * record in the grammar her prompt and her seeds use — never the store's
 * bookkeeping (`↳ exit 0 · 12 lines`, log paths, `ran … (exit 0, 3.1s)`).
 * Null leaves the row out.
 *
 * Left out, as live-work chrome that would only hand the worthiness gate
 * noise it then has to reject (consumer audit 2026-07-23):
 *  - "bg"   — a background command's start, its polls while running and
 *             an explicit stop: transient run state. Its EXIT row stays —
 *             that is an outcome, and a background test run's verdict used
 *             to reach the dream only through the marker's tail (dream
 *             review 2026-09-22, finding 17).
 *  - "todo" — the plan layout block: working state (same rationale as
 *             the live compaction's Planning/todo skip).
 *  - "skip" and a pre-digest `patch preview` — the full diff with nothing
 *             structured to fold it to. A dream prompt has no use for a
 *             hundred-line diff (dream review 2026-09-22, finding 1).
 *  - what Herta's prompt leaves out too: a memory save's kind, a planning
 *             step, a command that came back fine with nothing to show.
 *
 * Kept, each in her words:
 *  - a patch preview as its folded line, `改动 a.ts（+2 −1）` — the
 *             magnitude without the diff. The write step no longer carries
 *             it (`写 a.ts`), so the preview row is where it comes from.
 *  - an attachment as its one-line digest, `附件 spec.md（读过，原文不在
 *             手边）` — its name, never its text (see the evidence rule
 *             below) or where the store keeps it.
 *  - steps, markers and rows written before the structured digest as they
 *             read fresh, with `detail` (the evidence this digest keeps
 *             for the row, already filtered) under them.
 *  - every other row fresh while its evidence is in the digest, and as its
 *             folded line once it is not: `看过 a.ts 第 5–6 行（原文不在手
 *             边）` rather than a header over nothing, and a failed
 *             command named (`lastCommand`, the command its result row
 *             answers).
 */
export function systemRowForDream(
  b: SystemBlock,
  detail: string | null,
  lang: DigestLang = "zh",
  lastCommand?: string,
): string | null {
  const kind = b.digest?.kind;
  if (kind === "todo" || kind === "skip") return null;
  if (b.digest?.kind === "bg" && b.digest.state !== "exited") return null;
  if (b.digest === undefined && b.body.startsWith("patch preview")) return null;
  if (kind === "attachment") return digestSystemBlock(b, lang);
  if (kind === "patch") return foldedRunLine(b, lang);
  const fresh =
    kind === undefined ||
    kind === "op" ||
    b.role === "done-marker" ||
    b.role === "noop-marker" ||
    detail !== null;
  if (!fresh) return foldedRunLine(b, lang, lastCommand);
  const { evidenceDetail: _stored, ...rest } = b;
  const row = systemRowForHerta(
    detail !== null ? { ...rest, evidenceDetail: detail } : rest,
    lang,
  );
  if (row === null) return null;
  return row.evidenceDetail !== undefined && row.evidenceDetail.length > 0
    ? `${row.body}\n${row.evidenceDetail}`
    : row.body;
}

/** A path inside the harness's attachment store (ADR 0033), where every
 *  document the 开拓者 handed over is kept — relative or absolute, either
 *  separator. */
const ATTACHMENT_STORE = /\.herta[\\/]+attachments[\\/]/;

export function mentionsAttachmentStore(text: string): boolean {
  return ATTACHMENT_STORE.test(text);
}

/**
 * Whether a block's `evidenceDetail` belongs in the episode alongside its body.
 *
 * The body/evidence split is NOT the same question as the block-level skip
 * above: a block can be worth dreaming while its detail is not. Attachments
 * (ADR 0033) are the case that forced this apart. Their `evidenceDetail` holds
 * the head of a document the 开拓者 uploaded — the one payload in the record
 * that never came from the repo, the backend, or Herta — and dreams distil into
 * a first-person autobiography that persists across sessions. She should
 * remember being handed a spec; the spec's contents are not hers to keep.
 *
 * So the citation in `body` stays (that is what happened) and the detail is
 * dropped. Repo excerpts, search hits and command output are bounded work
 * evidence and have ridden into dreams since ADR 0027 — except where they
 * READ the attachment store (ADR 0069 §5): the fold's own hint sends Herta
 * back to the document through 板砖, and an excerpt of it, a search hit in
 * it or a `cat` of it carried the same text the attachment row withholds.
 * The rule is keyed on where the text came from, not on the row's kind.
 * `outputFromAttachmentStore` says the command whose output this row
 * carries named the store — an output row does not carry its command, so
 * the caller tracks it (`buildEpisodeDigest`).
 */
export function dreamRelevantEvidenceDetail(
  b: SystemBlock,
  outputFromAttachmentStore = false,
): string | null {
  if (b.digest?.kind === "attachment") return null;
  // A document digest's overview (ADR 0043) is the same document's contents
  // one step removed — a model's précis of what the user handed over — and
  // no more hers to keep than the head excerpt is. The row stays: she
  // remembers having 板砖 digest the file.
  if (b.digest?.kind === "digest") return null;
  const detail = b.evidenceDetail ?? null;
  if (detail === null) return null;
  if (b.digest?.kind === "excerpt" && mentionsAttachmentStore(b.digest.path)) {
    return null;
  }
  if (b.digest?.kind === "search") {
    // Hit lines are `path:line: content`: drop the store's, keep the repo's.
    const lines = detail.split("\n");
    const kept = lines.filter((l) => !mentionsAttachmentStore(l));
    const hits = kept.filter(
      (l) => !l.startsWith("↳ 匹配") && !l.startsWith("（另有"),
    );
    return hits.length === 0 ? null : kept.join("\n");
  }
  if (
    outputFromAttachmentStore &&
    (b.digest?.kind === "text" || b.digest?.kind === "bg")
  ) {
    return null;
  }
  return detail;
}

/**
 * At most this many of 板砖's rows reach one episode's digest — the most an
 * episode could carry before segmentation v2 let a long run stay whole
 * (ADR 0069 §7). Past it the digest keeps the run's first rows (what it set
 * out to do) and its last (how it ended), every marker, and a line saying
 * how many were left out.
 */
export const DIGEST_MAX_SYSTEM_ROWS = 60;
const DIGEST_HEAD_ROWS = 15;

/**
 * Characters of run evidence — excerpts, outputs, hit lists — one digest
 * carries, filled from the end: the rows nearest the verdict first. A
 * marker's own detail (files, risks, tests) always stays. Past the budget a
 * row loses its detail and reads as its folded line (`systemRowForDream`).
 */
export const DIGEST_EVIDENCE_BUDGET = 6000;

interface SystemRow {
  readonly block: SystemBlock;
  readonly evidence: string;
  readonly marker: boolean;
  /** The command a result row answers (`systemRowForDream`). */
  readonly lastCommand: string | undefined;
}

/** The outcome word a marker's state maps to (ExecutionStatus). */
const MARKER_OUTCOME: Readonly<Record<string, string>> = {
  failed: "失败",
  interrupted: "中断",
  blocked: "受阻",
  partial: "部分完成",
};

/**
 * The tag a system row carries in the digest: what the row IS (dream review
 * 2026-09-22, finding 17). Every row used to say 已核实 — verified — so an
 * interrupted run's marker and a raw error read as confirmed evidence of
 * the same kind as a passing test, and a dream could retell the run as
 * finished. A failed tool call is 失败; a run's marker says how the run
 * ended — 失败 / 中断 / 受阻 / 部分完成 — and only a completed run, and every
 * other record of what happened, stays 已核实.
 */
export function outcomeTag(b: SystemBlock): string {
  if (b.digest?.kind === "tool-fail") return "失败";
  if (b.role === "done-marker") {
    if (b.markerSummary !== undefined) {
      return MARKER_OUTCOME[b.markerSummary.state] ?? "已核实";
    }
    // A marker persisted before `markerSummary`: its body leads with the
    // state word.
    for (const word of ["失败", "中断", "受阻", "部分完成"]) {
      if (b.body.startsWith(word)) return word;
    }
  }
  return "已核实";
}

export function buildEpisodeDigest(
  blocks: readonly TerminalRecordBlock[],
  /** The dream pass's language: 板砖's rows read in it (ADR 0079 §3). The
   *  digest's own notation — `〔…（已核实）：…〕`, `开拓者：` — stays as it
   *  is in both (distill-prompt.ts). */
  lang: DigestLang = "zh",
): string {
  // Pass 1 — every system row the dream keeps, with its evidence, in order.
  // The latest `Running …` row named the attachment store: the output row
  // that follows carries that command's output (ADR 0069 §5). A command
  // started in the background answers much later, after other rows — its
  // id is remembered from the row that reported it running.
  const rows = new Map<number, SystemRow>();
  let afterAttachmentCommand = false;
  let lastCommand: string | undefined;
  const attachmentBackgroundIds = new Set<string>();
  blocks.forEach((b, i) => {
    if (b.kind !== "system") return;
    if (b.digest?.kind === "op") {
      afterAttachmentCommand =
        b.digest.verb === "Running" && mentionsAttachmentStore(b.digest.arg);
      if (b.digest.verb === "Running") lastCommand = b.digest.arg;
    }
    if (
      b.digest?.kind === "bg" &&
      b.digest.state === "running" &&
      afterAttachmentCommand
    ) {
      attachmentBackgroundIds.add(b.digest.id);
    }
    const fromStore =
      b.digest?.kind === "bg"
        ? attachmentBackgroundIds.has(b.digest.id)
        : afterAttachmentCommand;
    const detail = dreamRelevantEvidenceDetail(b, fromStore);
    // The ↳ 待办 roll-up line is dropped: open work items are operational
    // residue, not part of what happened.
    const evidence =
      detail === null
        ? ""
        : detail
            .split("\n")
            .filter((l) => !l.startsWith("↳ 待办"))
            .join("\n");
    // A row with nothing for her even with its evidence is not one of the
    // rows the bounds below count.
    if (
      systemRowForDream(
        b,
        evidence.length > 0 ? evidence : null,
        lang,
        lastCommand,
      ) === null
    ) {
      return;
    }
    rows.set(i, {
      block: b,
      evidence,
      marker: b.role === "done-marker" || b.role === "noop-marker",
      lastCommand,
    });
  });

  // Pass 2 — the bounds (ADR 0069 §7): which rows are left out, and which
  // keep their evidence.
  const order = [...rows.keys()];
  const elided = new Set<number>();
  if (order.length > DIGEST_MAX_SYSTEM_ROWS) {
    const tailFrom = order.length - (DIGEST_MAX_SYSTEM_ROWS - DIGEST_HEAD_ROWS);
    order.forEach((i, n) => {
      if (n >= DIGEST_HEAD_ROWS && n < tailFrom && rows.get(i)?.marker !== true)
        elided.add(i);
    });
  }
  const withEvidence = new Set<number>();
  let spent = 0;
  for (const i of [...order].reverse()) {
    const row = rows.get(i);
    if (row === undefined || elided.has(i) || row.evidence.length === 0) {
      continue;
    }
    if (row.marker || spent + row.evidence.length <= DIGEST_EVIDENCE_BUDGET) {
      withEvidence.add(i);
      if (!row.marker) spent += row.evidence.length;
    }
  }

  // Pass 3 — the digest.
  const parts: string[] = [];
  let noted = false;
  blocks.forEach((b, i) => {
    if (b.kind === "user") {
      parts.push(`开拓者：${b.text}`);
    } else if (b.kind === "herta") {
      // A supervisor-vetoed-then-corrected speech block carries the veto
      // reason in `selfCorrection`; surface it as a labeled self-correction
      // beat (a strong no-overclaim / honesty voice signal) before the final
      // corrected line. Mirrors how the live actor keeps it (serialize.ts).
      if (
        b.surface === "speech" &&
        b.selfCorrection !== undefined &&
        b.selfCorrection.length > 0
      ) {
        parts.push(`〔黑塔的自我更正：${b.selfCorrection}〕`);
      }
      parts.push(
        `${b.surface === "thought" ? "我（内心独白）" : "我"}：${b.text}`,
      );
    } else {
      const row = rows.get(i);
      if (row === undefined) return;
      if (elided.has(i)) {
        if (!noted) {
          parts.push(`〔……此处略去 ${elided.size} 条板砖操作记录〕`);
          noted = true;
        }
        return;
      }
      // Backend/system evidence — the outcome spine. Labeled by what it is,
      // so the model grounds the verdict in what actually happened; in the
      // words she read it in. A row that lost its evidence to the budget
      // reads as its folded line, or drops out when that leaves nothing.
      const text = systemRowForDream(
        row.block,
        withEvidence.has(i) ? row.evidence : null,
        lang,
        row.lastCommand,
      );
      if (text === null) return;
      parts.push(`〔${b.label}（${outcomeTag(b)}）：${text}〕`);
    }
  });
  return parts.join("\n");
}
