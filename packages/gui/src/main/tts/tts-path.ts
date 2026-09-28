import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isManifest } from "./bundle-verify.js";

/**
 * The bundle this build speaks with: the voice repo's `models/herta-best`
 * release (Stage 2 best checkpoint, epoch 72 — its `provenance.json` names it
 * `herta-best-e72`). The directory carries the release id so a later retrain
 * lands BESIDE it and the code says which one it expects, rather than a
 * bundle of unknown vintage silently answering to a generic name. Installed
 * and checksum-verified by `scripts/tts-bundle.mjs`.
 */
export const TTS_BUNDLE_ID = "herta-best-e72";

/**
 * Which of the two retained INT8 graphs ships. The voice repo keeps
 * `model.int8-81mb.onnx` (calibrated U8S8 reduced-range, sensitive vocoder
 * output in FP32; 85,111,939 bytes) and `model.int8-97mb.onnx` (more FP32
 * shortcut/prosody layers). On this non-VNNI CPU the larger one is ~8%
 * faster, not audibly better. Owner's call, 2026-09-05: the compact one.
 */
export const TTS_MODEL_FILE = "model.int8-81mb.onnx";

/**
 * The comm-channel treatment applied to every unit — she speaks over the
 * station terminal, so the dry studio render is band-limited with a faint,
 * speech-following noise floor (`terminal_textured`, listening-selected in
 * the voice repo on 2026-09-05 and the owner's pick for the app the same
 * day: "the 86MB one with tele terminal noise"). `none` is the dry voice;
 * `terminal` the older clean tone. Implemented in `comm-channel-effect.cjs`
 * beside the worker — pure JS, whole-unit, ~5 ms per second of audio.
 */
export const TTS_EFFECT = "terminal_textured";

/**
 * Where the neural-voice model bundle may live (ADR 0061), in priority
 * order: the DOWNLOADED copy under the app's user-data directory
 * (`<userData>/tts/<bundle id>` — Settings → Voice puts it there), then, in
 * dev only, the workspace's own `data/tts/<bundle id>` (the lab's install).
 * The installer carries no bundle (the owner's call on its size,
 * 2026-09-08), so a packaged app has exactly one place to look. Pure (the
 * caller injects `app.getPath("userData")` and the install mode,
 * install-mode.ts) so it unit-tests without electron.
 */
export function resolveTtsModelRoots(opts: {
  readonly userDataPath: string;
  readonly isPackaged: boolean;
  readonly workspaceRoot: string;
}): readonly string[] {
  const roots = [join(voiceModelStoreRoot(opts.userDataPath), TTS_BUNDLE_ID)];
  if (!opts.isPackaged) {
    roots.push(join(opts.workspaceRoot, "data", "tts", TTS_BUNDLE_ID));
  }
  return roots;
}

/** The directory the download installs bundles into: `<userData>/tts`. A
 *  bundle sits in `<store>/<bundle id>`; the download's temp files beside it. */
export function voiceModelStoreRoot(userDataPath: string): string {
  return join(userDataPath, "tts");
}

/**
 * The reference recording the MiniMax clone is made from (ADR 0062): the
 * game's archive lines merged into one 24 kHz WAV, shipped beside the voice
 * clips as `<resources>/voice-clone/` (its own tree — the clip payload check
 * would read a `.wav` under `voice/` as an untranscoded master), dev reads
 * `data/voice-clone/`.
 */
export const VOICE_CLONE_REFERENCE = "herta-reference.wav";

export function resolveVoiceCloneReference(opts: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly workspaceRoot: string;
}): string {
  const base = opts.isPackaged
    ? join(opts.resourcesPath, "voice-clone")
    : join(opts.workspaceRoot, "data", "voice-clone");
  return join(base, VOICE_CLONE_REFERENCE);
}

/** The files the Kokoro runtime actually opens (the `frontend/dict/` cppjieba
 *  tree is NOT among them — verified by smoke synthesis). `available()`
 *  reports false unless every one is present, so a partial/absent bundle
 *  degrades to the paced text reveal instead of a worker that dies on init.
 *  Mirrored in the private `scripts/tts-bundle.mjs` (the bundle installer)
 *  and in `bundle-verify.ts`'s manifest check after a download. */
const REQUIRED_FILES: readonly string[] = [
  TTS_MODEL_FILE,
  "voices.bin",
  "frontend/tokens.txt",
  "frontend/lexicon-us-en.txt",
  "frontend/lexicon-zh.txt",
  "frontend/phone-zh.fst",
  "frontend/date-zh.fst",
  "frontend/number-zh.fst",
];

/** True when `modelRoot` holds a usable bundle: every required file present
 *  and non-empty, the espeak-ng-data dir there, and — when the bundle
 *  carries its own manifest, as every downloaded one does — every listed
 *  file at its listed size (ADR 0061 §4.4: the check used to be existence
 *  only, so a truncated file that survived the swap read as installed).
 *  Sizes, not hashes: this runs at every launch and at every state read.
 *  Best-effort: any fs error → false. */
export function ttsBundleComplete(modelRoot: string): boolean {
  try {
    for (const rel of REQUIRED_FILES) {
      const p = join(modelRoot, rel);
      if (!existsSync(p)) return false;
      const st = statSync(p);
      if (!st.isFile() || st.size === 0) return false;
    }
    const espeak = join(modelRoot, "frontend", "espeak-ng-data");
    if (!existsSync(espeak) || !statSync(espeak).isDirectory()) return false;
    const manifestPath = join(modelRoot, "manifest.json");
    if (existsSync(manifestPath)) {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!isManifest(parsed)) return false;
      for (const f of parsed.files) {
        const p = manifestFilePath(modelRoot, f.path);
        if (p === null) return false;
        if (!existsSync(p) || statSync(p).size !== f.bytes) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** A manifest entry's file under `modelRoot`, or null for a path that could
 *  step outside it (`..`, `.`, an empty segment). */
function manifestFilePath(modelRoot: string, rel: string): string | null {
  const parts = rel.split("/");
  if (parts.some((s) => s === ".." || s === "" || s === ".")) return null;
  return join(modelRoot, ...parts);
}

/** `stat` that answers null for a path that does not exist — and throws for
 *  anything else, so an unreadable file fails the check as the sync twin's
 *  `statSync` does, instead of passing as absent. */
async function statOrNull(
  p: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * `ttsBundleComplete`, off the main thread (2026-09-24): the same checks
 * with every stat and the manifest read on libuv's pool, so a probe of a
 * bundle whose manifest lists hundreds of files no longer holds the app's
 * main thread (~50 ms at every launch, against ADR 0068's no-long-sync-fs
 * rule). Same answer as the sync twin for every bundle shape
 * (`tts-path.test.ts` runs both over the same fixtures).
 */
export async function ttsBundleCompleteAsync(
  modelRoot: string,
): Promise<boolean> {
  try {
    const required = await Promise.all(
      REQUIRED_FILES.map((rel) => statOrNull(join(modelRoot, rel))),
    );
    if (required.some((st) => st === null || !st.isFile() || st.size === 0)) {
      return false;
    }
    const espeak = await statOrNull(
      join(modelRoot, "frontend", "espeak-ng-data"),
    );
    if (espeak === null || !espeak.isDirectory()) return false;
    const manifestPath = join(modelRoot, "manifest.json");
    // `existsSync` semantics here, as in the twin: any failure reads "no
    // manifest"; a manifest that exists but will not read fails below.
    const hasManifest = await stat(manifestPath).then(
      () => true,
      () => false,
    );
    if (hasManifest) {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isManifest(parsed)) return false;
      const paths = parsed.files.map((f) =>
        manifestFilePath(modelRoot, f.path),
      );
      if (paths.some((p) => p === null)) return false;
      const sizes = await Promise.all(
        paths.map((p) => statOrNull(p as string)),
      );
      if (
        sizes.some((st, i) => st === null || st.size !== parsed.files[i]?.bytes)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
