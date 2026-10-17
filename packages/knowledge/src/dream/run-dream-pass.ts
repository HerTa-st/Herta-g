import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dreamDirFor, narrativeDirFor, type TerminalRecord } from "@herta/core";
import { promptAssetsFor } from "@herta/herta";
import type { DeepSeekClient } from "../llm/types.js";
import { resolveDreamConfig } from "./config.js";
import { buildEpisodeDigest } from "./digest.js";
import {
  buildCritiquePrompt,
  buildGenerationPrompt,
  buildReactivationGatePrompt,
  buildRefinePrompt,
  buildRetitlePrompt,
  buildWorthinessPrompt,
  type FeiAnSummary,
  type OccasionLine,
} from "./distill-prompt.js";
import { findEchoedRecords } from "./echo.js";
import {
  countFeianFiles,
  extractNarrativeOpening,
  parseFeianHeader,
  pickEvictableSeedFile,
  validateFeian,
} from "./feian-format.js";
import { DreamTransportError, jsonCall } from "./llm-json.js";
import { acquireDreamLock } from "./lock.js";
import {
  liveDreamRecords,
  markGistFolded,
  pickEvictionTarget,
  readManifestStrict,
  reinforceRecord,
  segmentationV2SinceMs,
  staleLiveRecords,
  writeManifest,
} from "./manifest.js";
import { titleNoveltyOk } from "./novelty.js";
import { archiveDreamRecord, readTextFile, recordEpisode } from "./pass-ops.js";
import { archiveLiveRecord, promoteCandidate } from "./promote.js";
import { reconcileDreamState } from "./reconcile.js";
import {
  findLiveById,
  runReconsolidationJunction,
} from "./reconsolidation-junction.js";
import { computeStrength } from "./retention.js";
import { segmentSession } from "./segment-session.js";
import { selectEpisodes } from "./select-episodes.js";
import {
  auditTrailblazerNotes,
  type EvictedFeianText,
  semanticizeEvictions,
} from "./semanticize.js";
import type { CritiqueScores, DreamConfig, DreamManifest } from "./types.js";
import { validateUserLines } from "./user-line-gate.js";

export interface DreamSessionInput {
  sessionId: string;
  /**
   * The session's record, or a thunk that loads it (audit BL10).
   *
   * The pass runs over every session in the workspace and awaits several LLM
   * calls per episode, so materializing all the records up front held every
   * transcript in main-process memory for the whole pass — minutes, on the
   * Electron main thread, growing with the user's history. A thunk is
   * resolved inside the loop, so at most one record is resident at a time.
   *
   * A plain record still works: callers that already have one in hand (tests,
   * the CLI lab) pass it directly.
   */
  record: TerminalRecord | (() => TerminalRecord);
  /**
   * How far this session is dreamable, as a block index into its record:
   * only an episode that ENDS at or before it is considered this pass
   * (ADR 0069 §2). The rest is neither dreamed nor ledgered, so a later
   * pass takes it up once it lies behind. Given for the session OPEN in the
   * app — its recap boundary, so the pass dreams only what compression has
   * already taken from the prompt. Asked when the record is loaded, so a
   * session opened or closed during a long pass is judged as it is then.
   * Absent, or answering undefined → every settled episode (closed
   * sessions, the manual CLI pass).
   */
  dreamableEnd?: (record: TerminalRecord) => number | undefined;
}

export interface RunDreamPassOptions {
  workspaceRoot: string;
  sessions: readonly DreamSessionInput[];
  client: DeepSeekClient;
  runId: string;
  config?: Partial<DreamConfig>;
  /** When true, bypass the dedup guard so already-dreamed episodes are re-processed. */
  reconsider?: boolean;
  now?: () => Date;
  /** Interaction language of THIS pass. Selects the per-language narrative /
   *  dream dirs AND the prompt bundle, so an EN pass grows English 废案 into
   *  `.herta/narrative-en` from English sessions, isolated from the zh corpus.
   *  The caller runs one pass per language over that language's sessions.
   *  Default "zh" — byte-identical to the pre-slice behavior. */
  lang?: "zh" | "en";
  /** Most episodes this pass sends through the LLM stages (dedup skips do
   *  not count). Past it the pass stops considering episodes: the rest stay
   *  undreamed and un-ledgered for a later pass, and the end-of-pass work
   *  runs as usual. Undefined = no limit (the manual CLI pass, which has its
   *  own cost cap); the automatic pass passes `autoPassMaxEpisodes`. */
  maxEpisodes?: number;
  /**
   * The user came back (dream review 2026-09-22, finding 12): asked before
   * each episode and before the end-of-pass model calls. On true the pass
   * steps aside — the episode in hand has finished, so nothing paid for is
   * thrown away; the rest stay undreamed and un-ledgered, the gist fold and
   * the notes audit wait (the fold's pending list is durable), and
   * `lastRunAt` does not advance, so the next idle window resumes where
   * this one stopped rather than a week later. Absent → never yields (the
   * manual CLI pass).
   */
  shouldYield?: () => boolean;
}

export interface RunDreamPassResult {
  promoted: number;
  archived: number;
  skipped: number;
  considered: number;
  /** Same-scenario duplicate that strengthened an existing dream (no text change). */
  reinforced: number;
  /** Same-scenario duplicate that matured an existing dream (donor graft). */
  reconsolidated: number;
  /** Retrieval-echo reinforcements (ADR 0023): live records strengthened
   *  because an episode's herta lines demonstrably REUSED one of their
   *  （我 说）/（我 想） moves (deterministic substring echo — use
   *  strengthens). Counts NON-spaced bumps only; a spacing-guarded echo is a
   *  retention no-op. Record-side events — episode ledger outcomes are
   *  unaffected. */
  echoReinforced: number;
  /** Seed-example 废案 (protectedSeedMaxNN < NN ≤ evictableSeedMaxNN) archived
   *  by the total-budget cap to make room for dream-created records. */
  seedsEvicted: number;
  /** Semanticization outcome: "updated" when dying dream records — and/or
   *  reactivation-stabilized LIVING records (ADR 0023) — were folded into the
   *  关于开拓者 page this pass, "failed" when the fold was attempted and lost
   *  (page untouched), absent when nothing was evicted and no living record
   *  crossed the fold threshold. */
  notesOutcome?: "updated" | "failed";
  /** Contradiction-audit outcome: "consistent" (no write), "revised" (page
   *  minimally corrected against living memories), "failed" (audit attempted
   *  and lost — page untouched). Absent when there is no page or no living
   *  dream record to challenge it. */
  notesAudit?: "consistent" | "revised" | "failed";
  /** Present when the pass stopped early on an LLM transport failure (network,
   *  HTTP, response shape). The in-flight and remaining episodes were NOT
   *  consumed — `lastRunAt` did not advance, so the trigger retries them. */
  aborted?: string;
  /** True when another pass held the cross-process lock; nothing was done. */
  lockBusy?: boolean;
  /** True when the pass reached `maxEpisodes` and left the rest for later. */
  budgetStopped?: boolean;
  /** True when `shouldYield` said the user came back and the pass stepped
   *  aside; `lastRunAt` did not advance. */
  yielded?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Error codes that mean the DISK refused (a lock, a full volume, a
 *  permission) rather than anything about the episode. */
const FILE_SYSTEM_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "EIO",
  "EROFS",
  "EAGAIN",
  "EEXIST",
]);

function isFileSystemError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && FILE_SYSTEM_CODES.has(code);
}

/** Stale-floor forgetting (the actual forgetting curve): archive every live
 *  record whose retention strength has decayed below `cfg.retentionFloor`. A
 *  no-op when the floor is 0 (default). Runs once per pass, before episodes, so
 *  an unreactivated dream fades even when the cap never binds. Seeds are never
 *  in `created`, so never touched. Returns the count archived. */
function forgetStale(
  manifest: DreamManifest,
  cfg: DreamConfig,
  narrativeDir: string,
  dreamDir: string,
  nowMs: number,
  now: () => Date,
): number {
  const stale = staleLiveRecords(manifest, nowMs, cfg);
  let forgotten = 0;
  for (const target of stale) {
    const strength = computeStrength(target, nowMs, cfg).toFixed(3);
    const outcome = archiveDreamRecord(
      manifest,
      target,
      narrativeDir,
      dreamDir,
      `forgotten: retention ${strength} < floor ${cfg.retentionFloor}`,
      now,
    );
    // Held open elsewhere: still live, not forgotten — the next pass tries.
    if (!outcome.archived) continue;
    forgotten++;
    markPendingFold(manifest, outcome.archivedAs);
  }
  return forgotten;
}

/** A dying dream's gist is owed to the 关于开拓者 page (finding 14): its
 *  archived name joins the manifest's pending list, flushed with the archive
 *  move itself, and the fold reads the body back from the archive. Seeds
 *  never route through here (their eviction path is archiveLiveRecord
 *  directly), and neither do reconsolidation supersede-archives — a
 *  reconsolidated memory lives on sharper, it is not forgotten. A file that
 *  had already vanished owes nothing. */
function markPendingFold(
  manifest: DreamManifest,
  archivedAs: string | null,
): void {
  if (archivedAs === null) return;
  manifest.pendingFold = [...(manifest.pendingFold ?? []), archivedAs];
}

/**
 * Make room for an incoming promotion under the TOTAL live 废案 budget
 * (M-feian-1, 2026-07-05 — previously the cap counted dream records only,
 * so the hand-authored corpus never participated in "full").
 *
 * Two-phase eviction while the live count (seeds + dreams, from the dir
 * listing) is at/over the cap:
 *   1. Seed examples first: the synthetic 开拓者-interaction seeds
 *      (protectedSeedMaxNN < NN ≤ evictableSeedMaxNN) archive highest-NN
 *      first — a real shared memory always outranks the scaffolding that
 *      stood in for it. Protected anchors (NN ≤ protectedSeedMaxNN: the
 *      voice anchor + the other-character 出处 grounding) are never touched.
 *   2. Then weakest dream by retention, as before.
 * Evicted seeds go to the dream archive like evicted dreams — recoverable,
 * never deleted. Returns the number of seeds archived (for the pass result).
 */
function enforceCap(
  manifest: DreamManifest,
  cfg: DreamConfig,
  narrativeDir: string,
  dreamDir: string,
  nowMs: number,
  now: () => Date,
): number {
  if (cfg.maxLiveCount <= 0) return 0;
  let seedsEvicted = 0;
  while (countFeianFiles(safeReaddir(narrativeDir)) >= cfg.maxLiveCount) {
    const liveFiles = new Set(liveDreamRecords(manifest).map((r) => r.file));
    const seed = pickEvictableSeedFile(
      safeReaddir(narrativeDir),
      liveFiles,
      cfg.protectedSeedMaxNN,
      cfg.evictableSeedMaxNN,
    );
    if (seed !== undefined) {
      try {
        archiveLiveRecord({
          narrativeDir,
          dreamDir,
          file: seed,
          reason: "cap-eviction: seed example replaced by dream-created 废案",
        });
      } catch {
        // Un-archivable seed (rename failed) — stop rather than spin on it;
        // the promotion proceeds over-budget this pass and the next pass
        // retries.
        break;
      }
      seedsEvicted += 1;
      continue;
    }
    // Interference-aware (ADR 0022): duplicated-situationTag records evict
    // first (redundancy before diversity); unique tags → weakest overall.
    const target = pickEvictionTarget(manifest, nowMs, cfg);
    if (target === undefined) break;
    const strength = computeStrength(target, nowMs, cfg).toFixed(3);
    const outcome = archiveDreamRecord(
      manifest,
      target,
      narrativeDir,
      dreamDir,
      `cap-eviction: retention ${strength} (interference-aware)`,
      now,
    );
    // Un-archivable (held open): stop rather than spin — the record stays
    // live, the promotion proceeds over budget this pass, the next retries.
    // The old path flipped it to archived anyway and went on to the next.
    if (!outcome.archived) break;
    markPendingFold(manifest, outcome.archivedAs);
  }
  return seedsEvicted;
}

/** Choose up to 2 exemplars for the generation prompt: one hand-authored seed
 *  anchor (the un-diluted voice reference — anti-drift) + the strongest
 *  dream-created 废案 by retention (proven, propagates good voice). Falls back
 *  to first-two-by-filename when no dream-created record exists yet. Offline
 *  only — this feeds `buildGenerationPrompt`, never the actor prefix. */
function pickExemplars(
  narrativeDir: string,
  manifest: DreamManifest,
  nowMs: number,
  cfg: DreamConfig,
): string[] {
  const files = listFeianFiles(narrativeDir);

  const live = liveDreamRecords(manifest);
  if (live.length === 0) {
    // No dream-created records — keep the original first-two-by-filename choice
    // (sorted, so _00 is oldest/first).
    return files
      .slice(0, 2)
      .map((f) => readTextFile(narrativeDir, f))
      .filter((t): t is string => t !== undefined);
  }

  // The set of dream-created filenames; anything else in narrative/ is a seed.
  const dreamFiles = new Set(live.map((r) => r.file));
  const seedFile = files.find((f) => !dreamFiles.has(f));
  const strongest = [...live].sort(
    (a, b) => computeStrength(b, nowMs, cfg) - computeStrength(a, nowMs, cfg),
  )[0];

  const chosen: string[] = [];
  if (seedFile !== undefined) {
    const t = readTextFile(narrativeDir, seedFile);
    if (t !== undefined) chosen.push(t);
  }
  if (strongest !== undefined && strongest.file !== seedFile) {
    const t = readTextFile(narrativeDir, strongest.file);
    if (t !== undefined) chosen.push(t);
  }
  // Fallback: if neither resolved (e.g. files vanished), fill from filenames.
  if (chosen.length === 0) {
    return files
      .slice(0, 2)
      .map((f) => readTextFile(narrativeDir, f))
      .filter((t): t is string => t !== undefined);
  }
  return chosen;
}

function firstHeaderLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line;
  }
  return "";
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** All 废案 files in the narrative dir, sorted by name for determinism
 *  (readdir order is platform-dependent; the loader convention is name order). */
function listFeianFiles(narrativeDir: string): string[] {
  return safeReaddir(narrativeDir)
    .filter((f) => f.startsWith("### 废案") && f.endsWith(".txt"))
    .sort();
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runDreamPass(
  opts: RunDreamPassOptions,
): Promise<RunDreamPassResult> {
  const cfg = resolveDreamConfig(opts.config);
  const now = opts.now ?? (() => new Date());
  // This pass's language selects BOTH the on-disk corpus dirs and the prompt
  // bundle, so an "en" pass grows English 废案 into `.herta/narrative-en`,
  // isolated from the zh corpus in `.herta/narrative`.
  const lang = opts.lang ?? "zh";
  const narrativeDir = narrativeDirFor(opts.workspaceRoot, lang);
  const dreamDir = dreamDirFor(opts.workspaceRoot, lang);

  const res: RunDreamPassResult = {
    promoted: 0,
    archived: 0,
    skipped: 0,
    considered: 0,
    reinforced: 0,
    reconsolidated: 0,
    echoReinforced: 0,
    seedsEvicted: 0,
  };

  // Cross-process exclusion (G4): a manual CLI run racing the idle trigger
  // must not double-reconsolidate records or last-writer-wins the manifest.
  const lock = acquireDreamLock(dreamDir, now().getTime());
  if (lock === undefined) {
    res.lockBusy = true;
    return res;
  }

  try {
    // A broken manifest stops the pass before anything is written: an empty
    // ledger in its place would re-dream everything as new (finding 8).
    // Reported like a transport abort — `lastRunAt` does not advance.
    const read = readManifestStrict(dreamDir);
    if (!read.ok) {
      res.aborted = read.reason;
      return res;
    }
    const manifest = read.manifest;
    // Segmentation v2 (ADR 0069 §4 and §7) starts with the first pass that
    // runs with it: every block in a record today predates this moment, so
    // it is cut as it always was and every ledgered episode keeps its hash.
    // Recorded with the manifest's next flush, and never moved after.
    if (manifest.segmentationV2Since === undefined) {
      manifest.segmentationV2Since = now().toISOString();
    }
    const segmentOpts = {
      ...cfg,
      segmentationV2SinceMs: segmentationV2SinceMs(manifest),
    };

    // Crash recovery: make the on-disk state and the ledger consistent before
    // the cap + dedup run — sweep stale temp files from an interrupted
    // promotion and prune phantom live records whose file has vanished. Does
    // NOT adopt unknown 废案 files (they may be hand-authored seeds; D7
    // never-touch-user-owned).
    reconcileDreamState({ narrativeDir, manifest, nowMs: now().getTime() });

    // Stale-floor forgetting (the forgetting curve): archive dreams whose
    // retention has decayed below the floor, once per pass, before episodes. A
    // no-op at the default floor of 0. Flush so a crash can't resurrect a fade
    // — the flush also carries the dying gists' pending-fold entries.
    const forgotten = forgetStale(
      manifest,
      cfg,
      narrativeDir,
      dreamDir,
      now().getTime(),
      now,
    );
    if (forgotten > 0) writeManifest(dreamDir, manifest);

    // Guide + env from THIS pass's language bundle (compiled in, M-prompts-1),
    // so an EN pass steers generation with the English voice reference.
    const assets = promptAssetsFor(lang);
    const guide = assets.hertaGuide;
    const env = assets.envSet;

    // Live corpus views for novelty + summaries (rebuilt fresh per episode to
    // reflect promotions that happened earlier in this same pass).
    const existingTitles = (): string[] =>
      listFeianFiles(narrativeDir)
        .map((f) => parseFeianHeader(f.replace(/\.txt$/, ""))?.title ?? "")
        .filter(Boolean);

    const dreamSummaries = (): FeiAnSummary[] =>
      liveDreamRecords(manifest).map((r) => ({
        title: parseFeianHeader(r.file.replace(/\.txt$/, ""))?.title ?? "",
        tag: r.situationTag,
        summary: r.summary ?? "",
        ...(r.occasion !== undefined ? { occasion: r.occasion } : {}),
      }));

    // Hand-authored seeds (narrative files with no manifest record). They
    // rejoin the GENERATION novelty steer and worthiness reject-#4: seed
    // titles/registers are exactly what a fresh candidate must diverge from.
    // (2026-07-16 lab regression: with an empty steer on a fresh corpus the
    // model titled every candidate as the seed series' next instalment —
    // which the title pre-screen then archived, 100% promotion failure.)
    // Seeds still deliberately do NOT join the reactivation gate below.
    const seedSummaries = (): FeiAnSummary[] => {
      const createdFiles = new Set(manifest.created.map((r) => r.file));
      return listFeianFiles(narrativeDir)
        .filter((f) => !createdFiles.has(f))
        .map((f) => ({
          title: parseFeianHeader(f.replace(/\.txt$/, ""))?.title ?? "",
          tag: "seed",
          summary: extractNarrativeOpening(readTextFile(narrativeDir, f) ?? ""),
        }))
        .filter((s) => s.title.length > 0);
    };
    /** Novelty-steer view: seeds + live dreams (what generation/worthiness
     *  diverge FROM) — distinct from the gate's live-only occasion view. */
    const steerSummaries = (): FeiAnSummary[] => [
      ...seedSummaries(),
      ...dreamSummaries(),
    ];

    // Reactivation-gate comparison set (ADR 0021): the LIVE dream records as
    // id → occasion pairs. Legacy records without a stored occasion fall back
    // to their summary (tolerant, additive schema — ADR 0021 §4). Hand-authored
    // seeds deliberately do NOT join: they are synthetic scaffolding, not
    // retellable real-life occasions — a seed can never be reactivated. (Their
    // filename/title collisions are still guarded by the deterministic title
    // pre-screen, and worthiness reject-#4 still sees the live corpus.)
    const occasionLines = (): OccasionLine[] =>
      liveDreamRecords(manifest).map((r) => ({
        id: r.id,
        occasion: r.occasion ?? r.summary ?? "",
      }));

    // O(1) dedup (audit BL10). `isEpisodeDreamed` scans the whole episode
    // ledger, and it was called once per candidate episode — quadratic in the
    // size of a manifest that only ever grows. Built once here and kept in
    // step as episodes are recorded below.
    const dreamedKeys = new Set(
      manifest.episodes.map((e) => `${e.sessionId}\u0000${e.episodeHash}`),
    );

    for (const s of opts.sessions) {
      // Resolved here, not up front, so one record is resident at a time.
      const record = typeof s.record === "function" ? s.record() : s.record;
      // Pass-time clock threaded for trailing-silence settling (ADR 0024):
      // a markerless session's final episode settles once the silence after
      // its last block exceeds episodeGapMs.
      const episodes = segmentSession(
        s.sessionId,
        record,
        segmentOpts,
        now().getTime(),
      );
      // The open session dreams only behind its recap boundary (ADR 0069
      // §2): what compression has already taken from the prompt. The same
      // inequality the reopen filter uses (`end > boundary` is verbatim).
      const dreamableEnd = s.dreamableEnd?.(record);
      const candidates = selectEpisodes(
        dreamableEnd === undefined
          ? episodes
          : episodes.filter((ep) => ep.endIndex <= dreamableEnd),
        cfg,
      );

      for (const ep of candidates) {
        // Skip if already processed in a prior pass (unless --reconsider
        // bypasses dedup). Done before the try so a pure dedup-skip needs no
        // manifest flush.
        if (
          !opts.reconsider &&
          dreamedKeys.has(`${ep.sessionId}\u0000${ep.episodeHash}`)
        ) {
          res.skipped++;
          continue;
        }
        // The user came back (finding 12): step aside between episodes,
        // before this one is marked seen.
        if (opts.shouldYield?.() === true) {
          res.yielded = true;
          break;
        }
        // The spend ceiling (dream review 2026-09-22, finding 3): checked
        // before the episode is marked seen, so what the pass leaves is
        // simply undreamed — the next pass takes it up.
        if (
          opts.maxEpisodes !== undefined &&
          res.considered >= opts.maxEpisodes
        ) {
          res.budgetStopped = true;
          break;
        }
        dreamedKeys.add(`${ep.sessionId}\u0000${ep.episodeHash}`);
        try {
          res.considered++;
          const digest = buildEpisodeDigest(ep.blocks, lang);

          // ── 0. Retrieval-echo reinforcement (ADR 0023) ────────────────────
          // Use strengthens (docs/what-is-memory.md §7): when this episode's
          // herta lines demonstrably REUSE a live memory's move — a
          // distinctive contiguous run from its （我 说）/（我 想） lines
          // re-appearing in her live speech/thought — that memory served as
          // few-shot material and is reinforced. Deterministic, no LLM. Runs
          // BEFORE worthiness so echoes count even for episodes the gates
          // later skip or archive. A record-side event only: the episode's
          // own ledger outcome is unchanged. Self-source guards (a 废案
          // trivially echoes the session it was distilled from) live in
          // findEchoedRecords; the ADR 0022 spacing guard rides along.
          if (cfg.echoMinChars > 0) {
            for (const echoed of findEchoedRecords(
              ep,
              liveDreamRecords(manifest),
              narrativeDir,
              cfg.echoMinChars,
            )) {
              const r = reinforceRecord(
                manifest,
                echoed.id,
                now().toISOString(),
                cfg.reinforceSpacingMs,
              );
              if (r !== undefined && !r.spaced) res.echoReinforced++;
            }
          }

          // ── 1. Worthiness gate (also extracts the episode's occasion) ─────
          const worthyResult = await jsonCall<{
            worthy: boolean;
            reason?: string;
            occasion?: string;
            retellsKnownEvent?: boolean;
            mixedTopics?: boolean;
          }>(
            opts.client,
            buildWorthinessPrompt(digest, steerSummaries(), env, lang),
            cfg.model,
            cfg.gateEffort,
          );

          // The episode's real-life occasion (ADR 0021): factual sentences the
          // worthiness call extracted alongside its verdict. Best-effort — an
          // absent or non-string occasion never blocks the pipeline; the record
          // then promotes without one (the gate falls back to its summary).
          const epOccasion =
            typeof worthyResult?.occasion === "string" &&
            worthyResult.occasion.trim().length > 0
              ? worthyResult.occasion.trim()
              : undefined;

          if (worthyResult === undefined || !worthyResult.worthy) {
            // Unworthy RETELL → repetition still strengthens (ADR 0021 §10):
            // a verbatim re-telling that teaches no new voice move is not
            // corpus material, but it IS a reactivation of the event's
            // memory. One cheap gate call (no generation) resolves which
            // live record it strengthens; anything unresolvable falls
            // through to the plain skip.
            if (
              worthyResult?.retellsKnownEvent === true &&
              liveDreamRecords(manifest).length > 0
            ) {
              const gate = await jsonCall<{
                sameOccasion: boolean;
                matchedId?: string;
              }>(
                opts.client,
                buildReactivationGatePrompt(
                  {
                    digest,
                    ...(epOccasion !== undefined
                      ? { occasion: epOccasion }
                      : {}),
                  },
                  occasionLines(),
                  lang,
                ),
                cfg.model,
                cfg.gateEffort,
              );
              const matched =
                gate?.sameOccasion === true
                  ? findLiveById(manifest, gate.matchedId)
                  : undefined;
              if (matched !== undefined) {
                const r = reinforceRecord(
                  manifest,
                  matched.id,
                  now().toISOString(),
                  cfg.reinforceSpacingMs,
                );
                recordEpisode(
                  manifest,
                  ep,
                  "reinforced",
                  `unworthy retell reinforced ${matched.file}${r?.spaced === true ? " (spaced)" : ""}`,
                  now,
                );
                res.reinforced++;
                continue;
              }
            }
            // A TERMINAL skip needs a real answer (audit 2026-07-24, 1.12):
            // an explicit `worthy === false`, or a reply that did not parse
            // at all (which the owner deliberately classes a quality failure
            // — pinned by run-dream-pass.test.ts, and left as-is here).
            //
            // What was never considered is the shape in between: a reply that
            // PARSES but carries no readable verdict — truncation at the token
            // cap, a `{"result":{…}}` envelope, a renamed key. That took the
            // same terminal branch, and the ledger reason admitted the
            // conflation ("unworthy or unparseable model output"). Since every
            // ledger write is terminal (isEpisodeDreamed tests PRESENCE, not
            // outcome), an unreadable answer silently deleted the evening
            // forever — no retry, no signal, on a detached pass that swallows
            // errors. `llm-json.ts` already applies this reasoning to
            // transport failures; the discipline just stopped at that
            // boundary.
            if (worthyResult === undefined || worthyResult.worthy === false) {
              recordEpisode(
                manifest,
                ep,
                "skipped",
                worthyResult?.reason ?? "unworthy or unparseable model output",
                now,
              );
              res.skipped++;
              continue;
            }
            // Parsed, but no readable verdict → leave NO ledger entry so the
            // next pass retries this episode (the abort path's contract).
            continue;
          }

          // An excerpt that strings together unrelated topics (finding 22):
          // the gate judged the most memorable one and named it; the page
          // tells that one, and the critique judges faithfulness against it.
          const focus =
            worthyResult.mixedTopics === true ? epOccasion : undefined;

          // ── 2. Generate + refine-on-validator-error ───────────────────────
          const genResult = await jsonCall<{
            feian: string;
            situationTag: string;
          }>(
            opts.client,
            buildGenerationPrompt(
              digest,
              pickExemplars(narrativeDir, manifest, now().getTime(), cfg),
              steerSummaries(),
              guide,
              env,
              lang,
              focus,
            ),
            cfg.model,
            cfg.generationEffort,
          );

          if (genResult === undefined || typeof genResult.feian !== "string") {
            recordEpisode(
              manifest,
              ep,
              "archived",
              "unparseable model output (generation)",
              now,
            );
            res.archived++;
            continue;
          }

          let gen: { feian: string; situationTag: string } = genResult;
          // Format gate + user-line gate share the refine loop (ADR 0036):
          // the 开拓者's quoted lines must be traceable to the episode's real
          // user messages — the LLM faithfulness critique passed a page with
          // four INVENTED user turns (persona E2E 2026-08-11), and a promoted
          // counterfeit becomes prefix "memory" no later check can reach.
          // Feeding the failures through buildRefinePrompt first gives the
          // draft a chance to re-quote before it is archived.
          const epUserTexts = ep.blocks
            .filter((b) => b.kind === "user")
            .map((b) => (b.kind === "user" ? b.text : ""));
          const checkDraft = (
            feian: string,
          ): { ok: boolean; errors: string[] } => {
            const v = validateFeian(feian);
            const u = validateUserLines(feian, epUserTexts);
            return {
              ok: v.ok && u.ok,
              errors: [...(v.ok ? [] : v.errors), ...u.errors],
            };
          };
          let valid = checkDraft(gen.feian);

          for (let k = 0; !valid.ok && k < cfg.refineMaxRetries; k++) {
            const refined = await jsonCall<{
              feian: string;
              situationTag?: string;
            }>(
              opts.client,
              buildRefinePrompt(gen.feian, valid.errors, guide, lang),
              cfg.model,
              cfg.gateEffort,
            );
            if (refined === undefined || typeof refined.feian !== "string")
              break;
            gen = {
              feian: refined.feian,
              situationTag: refined.situationTag ?? gen.situationTag,
            };
            valid = checkDraft(gen.feian);
          }

          if (!valid.ok) {
            recordEpisode(
              manifest,
              ep,
              "archived",
              `invalid after refine: ${valid.errors.join("; ")}`,
              now,
            );
            res.archived++;
            continue;
          }

          const header = parseFeianHeader(firstHeaderLine(gen.feian));
          let title = header?.title ?? "未命名";
          const opening = extractNarrativeOpening(gen.feian);

          // ── 3. Novelty: title pre-screen + occasion reactivation gate ─────
          // The deterministic title pre-screen stays: it guards filename/title
          // collisions (a different job from occasion identity — ADR 0021).
          if (!titleNoveltyOk(title, existingTitles())) {
            // Title-collision SALVAGE (2026-07-16 lab): the episode is paid,
            // worthy, and format-valid — only its TITLE collides (models
            // occasionally title a candidate as an existing series' next
            // instalment). One cheap retitle call + a deterministic header
            // rewrite; only a second failure archives, and the ledger names
            // the colliding title (a bare "duplicate title" was undiagnosable).
            const retitled = await jsonCall<{ title?: string }>(
              opts.client,
              buildRetitlePrompt(opening, title, existingTitles(), lang),
              cfg.model,
              cfg.gateEffort,
            );
            const newTitle =
              typeof retitled?.title === "string" ? retitled.title.trim() : "";
            const fl = firstHeaderLine(gen.feian);
            const salvageable =
              newTitle.length > 0 &&
              fl.endsWith(title) &&
              titleNoveltyOk(newTitle, existingTitles());
            const rewritten = salvageable
              ? gen.feian.replace(
                  fl,
                  fl.slice(0, fl.length - title.length) + newTitle,
                )
              : null;
            if (rewritten === null || !validateFeian(rewritten).ok) {
              recordEpisode(
                manifest,
                ep,
                "archived",
                `duplicate title: ${title}` +
                  (newTitle.length > 0
                    ? ` (retitle → ${newTitle} failed)`
                    : ""),
                now,
              );
              res.archived++;
              continue;
            }
            gen = { ...gen, feian: rewritten };
            title = newTitle;
          }

          // Reactivation gate (ADR 0021): judged on the EPISODE (digest +
          // worthiness-extracted occasion) against the live records' occasion
          // lines — never on the freshly distilled artifact, whose title and
          // summary legitimately diverge across retellings of one occasion.
          // With no live record there is nothing to reactivate — skip the call.
          const liveOccasions = occasionLines();
          const gateResult =
            liveOccasions.length === 0
              ? { sameOccasion: false }
              : await jsonCall<{
                  sameOccasion: boolean;
                  matchedId?: string;
                  reason?: string;
                }>(
                  opts.client,
                  buildReactivationGatePrompt(
                    {
                      digest,
                      ...(epOccasion !== undefined
                        ? { occasion: epOccasion }
                        : {}),
                    },
                    liveOccasions,
                    lang,
                  ),
                  cfg.model,
                  cfg.gateEffort,
                );

          if (gateResult === undefined) {
            recordEpisode(
              manifest,
              ep,
              "archived",
              "unparseable model output (reactivation gate)",
              now,
            );
            res.archived++;
            continue;
          }

          // `=== true`, not truthiness (audit 2026-07-24, 1.11). `jsonCall`
          // casts blindly, so the `boolean` in the type annotation is
          // fiction: a stringly-typed `"false"` is TRUTHY and INVERTS the
          // gate's own documented default ("Default to sameOccasion:
          // false"), sending a novel 废案 into the junction where an
          // also-drifted matchedId fails to resolve and the record is
          // discarded as a near-dup — permanently, since the ledger entry
          // makes `isEpisodeDreamed` skip it forever. The sibling call 190
          // lines up already guards this way; this site was the outlier.
          if (gateResult.sameOccasion === true) {
            // ── Reconsolidation junction (slice 2, ADR 0021) ────────────────
            // A retelling of the same real-life occasion: instead of
            // discarding the new understanding, reactivate the matched dream
            // (or archive when the matched id cannot be resolved to a live
            // record).
            const outcome = await runReconsolidationJunction(
              {
                client: opts.client,
                cfg,
                manifest,
                narrativeDir,
                dreamDir,
                guide,
                runId: opts.runId,
                now,
                lang,
              },
              ep,
              gen,
              digest,
              gateResult,
              epOccasion,
            );
            res[outcome]++;
            continue;
          }

          // ── 4. Critique → voice-fidelity + faithfulness gates ─────────────
          // The digest rides along so the critique can score faithfulness:
          // does the page dramatize the SOURCE episode's core event
          // (2026-07-19 — the ADR 0024 acceptance run caught a grief
          // occasion retold as unrelated fiction).
          const scoresResult = await jsonCall<CritiqueScores>(
            opts.client,
            buildCritiquePrompt(gen.feian, guide, lang, digest, focus),
            cfg.model,
            cfg.gateEffort,
          );

          if (
            scoresResult === undefined ||
            typeof scoresResult.voice !== "number" ||
            typeof scoresResult.format !== "number" ||
            typeof scoresResult.novelty !== "number"
          ) {
            recordEpisode(
              manifest,
              ep,
              "archived",
              "unparseable model output (critique)",
              now,
            );
            res.archived++;
            continue;
          }

          if (scoresResult.voice < cfg.minVoiceScore) {
            recordEpisode(
              manifest,
              ep,
              "archived",
              `low voice ${scoresResult.voice}`,
              now,
            );
            res.archived++;
            continue;
          }

          // Faithfulness gate: archives a page that abandoned its source
          // episode's substance. Gated only when the critique returned a
          // finite number — an absent score (legacy reply shape) promotes
          // ungated, like charge.
          if (
            typeof scoresResult.faithfulness === "number" &&
            Number.isFinite(scoresResult.faithfulness) &&
            scoresResult.faithfulness < cfg.minFaithfulnessScore
          ) {
            recordEpisode(
              manifest,
              ep,
              "archived",
              `low faithfulness ${scoresResult.faithfulness}`,
              now,
            );
            res.archived++;
            continue;
          }

          // Encode-time emotional charge (ADR 0023, flashbulb encoding):
          // stored clamped to [0,1] when the critique returned a finite
          // number; absent or invalid → omitted — the charge never blocks a
          // promotion (retention then reads it as 0, pure voice).
          const charge =
            typeof scoresResult.charge === "number" &&
            Number.isFinite(scoresResult.charge)
              ? Math.min(1, Math.max(0, scoresResult.charge))
              : undefined;

          // ── 5. Promote (atomic) with cap: seed-examples-first, then
          //      evict-weakest-dream (total 废案 budget, M-feian-1) ─────────
          res.seedsEvicted += enforceCap(
            manifest,
            cfg,
            narrativeDir,
            dreamDir,
            now().getTime(),
            now,
          );

          const { nn, file } = promoteCandidate({
            narrativeDir,
            dreamDir,
            title,
            feianBody: gen.feian,
            runId: opts.runId,
          });

          manifest.created.push({
            id: `${opts.runId}:${ep.episodeHash.slice(0, 8)}`,
            file,
            nn,
            state: "live",
            sourceSessionId: ep.sessionId,
            sourceEpisodeHash: ep.episodeHash,
            sourceEpisodes: [ep.episodeHash],
            runId: opts.runId,
            model: cfg.model,
            generatedAt: now().toISOString(),
            situationTag: gen.situationTag,
            summary: opening,
            critiqueScores: scoresResult,
            validateFeianPassed: true,
            reactivationCount: 0,
            // The worthiness-extracted occasion (ADR 0021) — the record's
            // stable real-life identity for future reactivation. Optional:
            // an absent extraction never blocks promotion.
            ...(epOccasion !== undefined ? { occasion: epOccasion } : {}),
            // The critique's emotional charge (ADR 0023), clamped above.
            ...(charge !== undefined ? { emotionalCharge: charge } : {}),
          });

          recordEpisode(manifest, ep, "promoted", `→ ${file}`, now);
          res.promoted++;
        } catch (err) {
          if (err instanceof DreamTransportError) {
            // The LLM call itself failed (network/HTTP/shape) — abort the pass
            // WITHOUT recording a ledger entry: the episode stays undreamed and
            // is retried next pass. Recording it here would let a transient
            // outage permanently consume material.
            res.aborted = err.detail;
          } else if (isFileSystemError(err)) {
            // The disk refused a write — the promotion rename under an AV
            // scan, an indexer or OneDrive on `.herta/narrative`. The same
            // shape as an outage (finding 7): the episode was ledgered
            // `archived: error` and never tried again, a memory consumed by
            // a lock. Abort without consuming it; the next pass retries.
            res.aborted = `write failed: ${(err as { code: string }).code}`;
          } else {
            recordEpisode(
              manifest,
              ep,
              "archived",
              `error: ${String(err)}`,
              now,
            );
            res.archived++;
          }
        } finally {
          // Persist this episode's outcome immediately (atomic write) so a
          // power-off mid-pass loses at most the in-flight episode — every
          // promotion stays tracked and dedup advances incrementally.
          writeManifest(dreamDir, manifest);
        }
        if (res.aborted !== undefined) break;
      }
      if (
        res.aborted !== undefined ||
        res.budgetStopped === true ||
        res.yielded === true
      ) {
        break;
      }
    }
    // The end-of-pass work below is model calls too: a user who came back
    // during the last episode is not kept waiting behind them.
    if (res.yielded !== true && opts.shouldYield?.() === true) {
      res.yielded = true;
    }

    // Living-memory semanticization sources (ADR 0023 — consolidation
    // without death, docs/what-is-memory.md §8): live records reactivated at
    // least `semanticizeReactivationThreshold` times have proven stable, and
    // their understanding of the Trailblazer joins the same notes fold as the
    // dying records — WITHOUT the memory dying. Once per record: `gistFolded`
    // is flagged only when the fold outcome is "updated", so a failed fold
    // leaves the flag unset and retries next pass for free.
    const foldThreshold = cfg.semanticizeReactivationThreshold;
    const stabilizedTexts: EvictedFeianText[] = [];
    const stabilizedIds: string[] = [];
    if (foldThreshold > 0) {
      for (const r of liveDreamRecords(manifest)) {
        if (r.reactivationCount < foldThreshold || r.gistFolded === true) {
          continue;
        }
        const body = readTextFile(narrativeDir, r.file);
        if (body === undefined) continue;
        stabilizedTexts.push({ file: r.file, body });
        stabilizedIds.push(r.id);
      }
    }

    // The dying gists owed to the page: every archived name on the manifest's
    // pending list — this pass's forgettings and any an aborted or crashed
    // earlier pass left owing (finding 14) — read back from the archive. A
    // name whose file is gone owes nothing more and leaves the list.
    const archiveDir = join(dreamDir, "archive");
    const evictedForNotes: EvictedFeianText[] = [];
    const pendingNames: string[] = [];
    for (const name of manifest.pendingFold ?? []) {
      const body = readTextFile(archiveDir, name);
      if (body === undefined) continue;
      evictedForNotes.push({ file: name, body });
      pendingNames.push(name);
    }
    if ((manifest.pendingFold?.length ?? 0) !== pendingNames.length) {
      manifest.pendingFold = pendingNames;
      writeManifest(dreamDir, manifest);
    }

    // Semanticization (best-effort, after the loops): fold the forgotten
    // dreams' gist — and the stabilized living records' (ADR 0023) — into the
    // 关于开拓者 / "About the Trailblazer" page. Failures leave the page
    // untouched and never abort the pass — the forgetting already happened,
    // and blocking completion on this step would let a flaky call re-trigger
    // everything. A failed fold keeps the pending list: the next pass folds
    // the same gists.
    //
    // Language-aware (ADR 0017 follow-up): each language folds into its OWN
    // notes page (this pass's per-language narrativeDir + notesFileFor/
    // notesHeaderFor selected by `lang`); the `### 记录` prefix stays CN in
    // both so the static-prefix loader still matches.
    if (
      res.yielded !== true &&
      (evictedForNotes.length > 0 || stabilizedTexts.length > 0)
    ) {
      const outcome = await semanticizeEvictions({
        narrativeDir,
        // Enables the pre-overwrite backup of the notes page — the one corpus
        // artifact that had no recovery path (audit 2026-07-24, 2.1).
        dreamDir,
        client: opts.client,
        cfg,
        evicted: evictedForNotes,
        stabilized: stabilizedTexts,
        guide,
        runId: opts.runId,
        lang,
      });
      if (outcome !== "none") res.notesOutcome = outcome;
      // The living fold landed exactly when the page write did: flag the
      // folded records (immutably, like reinforceRecord) and flush. On
      // "failed" the flags stay unset — the fold retries next pass.
      if (outcome === "updated" && stabilizedIds.length > 0) {
        markGistFolded(manifest, stabilizedIds);
        writeManifest(dreamDir, manifest);
      }
      // The dying gists reached the page: they are owed no more.
      if (outcome === "updated" && pendingNames.length > 0) {
        delete manifest.pendingFold;
        writeManifest(dreamDir, manifest);
      }
    }

    // Contradiction audit (fossilization mitigation): the strongest living
    // dreams get to challenge the notes page once per pass. Runs AFTER the
    // fold so it audits the final page; consistent:true costs no write.
    // Best-effort like the fold — a failure leaves the page untouched. Runs for
    // BOTH languages now (ADR 0017 follow-up); auditTrailblazerNotes no-ops
    // (returns "none") while the page is still empty, so a fresh EN corpus with
    // no notes page yet costs nothing.
    if (res.yielded !== true && opts.shouldYield?.() === true) {
      res.yielded = true;
    }
    if (res.yielded !== true) {
      const living = [...liveDreamRecords(manifest)]
        .sort(
          (a, b) =>
            computeStrength(b, now().getTime(), cfg) -
            computeStrength(a, now().getTime(), cfg),
        )
        .slice(0, cfg.notesAuditMaxRecords)
        .map((r) => {
          const body = readTextFile(narrativeDir, r.file);
          return body === undefined ? undefined : { file: r.file, body };
        })
        .filter((t): t is EvictedFeianText => t !== undefined);
      const audit = await auditTrailblazerNotes({
        narrativeDir,
        dreamDir,
        client: opts.client,
        cfg,
        living,
        guide,
        runId: opts.runId,
        lang,
      });
      if (audit !== "none") res.notesAudit = audit;
    }

    // Mark the pass complete: lastRunAt advances only on a FULL pass, so a
    // crashed or transport-aborted pass does not reset the weekly cadence — the
    // trigger retries and resumes (dedup skips the episodes already flushed).
    // A pass that stepped aside for the user resumes the same way.
    if (res.aborted === undefined && res.yielded !== true) {
      manifest.lastRunAt = now().toISOString();
    }
    writeManifest(dreamDir, manifest);
    return res;
  } finally {
    lock.release();
  }
}
