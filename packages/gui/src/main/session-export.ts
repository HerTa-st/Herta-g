import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Save a session's Markdown export (ADR 0072 §3). The renderer builds the
 * text — the localized row wording lives there — and main only asks where
 * to put it and writes it: the path is the user's pick in the save dialog,
 * so nothing the renderer sends can name a place on disk.
 */

/** Longest file-name stem an export suggests, in characters. */
const MAX_STEM_CHARS = 80;
/** A bound on what the renderer may hand over. A long session's export is a
 *  few megabytes; this only refuses nonsense. */
export const MAX_EXPORT_CHARS = 64 * 1024 * 1024;

/**
 * The suggested file name for a session titled `title`: characters no file
 * system takes become spaces, spaces collapse, the stem is capped, trailing
 * dots and spaces go (Windows drops them), and a Windows device name gets a
 * suffix. An empty result falls back to `fallback`.
 */
export function exportFileName(title: string, fallback = "Herta"): string {
  const cleaned = [
    ...title
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a file name cannot carry
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, MAX_STEM_CHARS)
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const stem = cleaned === "" ? fallback : cleaned;
  const safe = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)
    ? `${stem}_`
    : stem;
  return `${safe}.md`;
}

export interface ExportSaverDeps {
  showSaveDialog(opts: {
    readonly defaultPath: string;
    readonly filters: readonly {
      readonly name: string;
      readonly extensions: readonly string[];
    }[];
  }): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  /** Where the first export of a run is offered. */
  documentsDir(): string;
  writeFile?(path: string, data: string): Promise<void>;
  log?(line: string): void;
  /** `MAX_EXPORT_CHARS` unless a test lowers it. */
  maxChars?: number;
}

export type ExportSaveResult = {
  readonly saved: boolean;
  readonly failed?: boolean;
};

/** The save handler. It remembers the folder of the last export for the
 *  rest of the run, so a second export opens where the first went. */
export function createExportSaver(
  deps: ExportSaverDeps,
): (suggestedName: unknown, markdown: unknown) => Promise<ExportSaveResult> {
  const write =
    deps.writeFile ?? ((path, data) => writeFile(path, data, "utf8"));
  const log = deps.log ?? ((line) => console.log(line));
  const maxChars = deps.maxChars ?? MAX_EXPORT_CHARS;
  let lastDir: string | null = null;
  return async (suggestedName, markdown) => {
    if (
      typeof suggestedName !== "string" ||
      typeof markdown !== "string" ||
      markdown.length > maxChars
    ) {
      return { saved: false, failed: true };
    }
    const r = await deps.showSaveDialog({
      defaultPath: join(
        lastDir ?? deps.documentsDir(),
        exportFileName(suggestedName),
      ),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (r.canceled || r.filePath === undefined || r.filePath === "") {
      return { saved: false };
    }
    try {
      await write(r.filePath, markdown);
    } catch (err) {
      // Never the path: it can carry the user's name.
      log(
        `[herta] export: the write failed (${(err as { code?: string }).code ?? "error"})`,
      );
      return { saved: false, failed: true };
    }
    lastDir = dirname(r.filePath);
    log("[herta] export: saved");
    return { saved: true };
  };
}
