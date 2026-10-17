/**
 * The site's stand-in for the device scene's GPU probe (2026-10-14). The
 * site's scene is a picture (src/demo-device-scene.tsx), which any browser
 * can show: the probe would only make a WebGL context for nothing, and on a
 * software renderer or a remote desktop send the visitor the flat art.
 * Aliased over `device-scene/capability.js` in vite.config.ts.
 */
export function detectDeviceScenePath(): Promise<boolean> {
  return Promise.resolve(true);
}
