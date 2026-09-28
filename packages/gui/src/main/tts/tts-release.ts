import { TTS_BUNDLE_ID } from "./tts-path.js";

/**
 * The voice-model archive this build downloads (ADR 0061). The model is not
 * in the installer — the owner's call, 2026-09-08, on its size — so the app
 * fetches ONE archive on the user's say-so and verifies it against the hash
 * pinned HERE before a byte of it is extracted. A retrain is a new bundle id
 * (`TTS_BUNDLE_ID`), a new archive, new pins, and therefore an app release:
 * the download never trusts the host, only this file.
 *
 * Produced by `packages/gui/scripts/pack-tts.mjs` from the installed bundle
 * (deterministic — re-packing the same bundle reproduces the hash); the
 * script prints the three numbers to paste below. Hosted as an asset of a
 * dedicated release on the public repo, tagged by the bundle id so app
 * releases and model releases stay independent.
 */
export const TTS_ARCHIVE_NAME = `${TTS_BUNDLE_ID}.tar.gz`;
export const TTS_ARCHIVE_URL = `https://github.com/PersonaCLI/Herta/releases/download/voice-${TTS_BUNDLE_ID}/${TTS_ARCHIVE_NAME}`;
/** From pack-tts (2026-09-08, bundle herta-best-e72 as verified by
 *  tts-bundle.mjs: 366 files + manifest): the archive's exact byte count and
 *  SHA-256. */
export const TTS_ARCHIVE_BYTES = 76_255_506;
export const TTS_ARCHIVE_SHA256 =
  "ce993a6fab911e9a86328facc952120c21de54303652f648e96e9d14ee4f172e";
/** The extracted bundle's size, for the Settings copy and the extractor's cap. */
export const TTS_BUNDLE_BYTES = 115_897_197;

/** Dev-only override of the archive's location (a local server for the lab,
 *  a staging host). Gated on a non-installed app by the caller, the same T1.3
 *  rule as the update-feed override; the hash pin applies regardless. */
export const TTS_ARCHIVE_URL_ENV = "HERTA_TTS_ARCHIVE_URL";
