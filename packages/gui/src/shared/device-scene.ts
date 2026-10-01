/**
 * The 3D device card's asset scheme (ADR 0057), shared by main (the
 * protocol handler) and the renderer (the URLs three.js loads from).
 *
 * `herta-asset://device-scene/<file>` serves the compact baked asset set
 * (GLB meshes, KTX2 atlases, scalar PNGs, the Basis transcoder) from the
 * bundled renderer directory. A scheme rather than `connect-src 'self'`
 * because the packaged renderer's origin is `file://`, where `'self'` would
 * let an injected script read ANY local file — the exact surface audit BL2
 * closed. The scheme is read-only, allowlisted by extension, and rooted in
 * the app bundle (see main/asset-protocol.ts).
 */
export const DEVICE_SCENE_SCHEME = "herta-asset";

/** The one host the scheme serves; anything else is a uniform 404. */
export const DEVICE_SCENE_HOST = "device-scene";

/** Build the URL of one bundled device-scene asset. */
export function deviceSceneAssetUrl(file: string): string {
  return `${DEVICE_SCENE_SCHEME}://${DEVICE_SCENE_HOST}/${file}`;
}
