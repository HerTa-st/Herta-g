/**
 * The one renderer permission the app grants. Audit BL22 denied them all:
 * Electron grants every permission by default, and a blanket deny meant a
 * future dependency could not quietly acquire the camera, the microphone,
 * geolocation or notifications on a window that also holds the app's IPC
 * bridge. That still holds for everything but `clipboard-sanitized-write`,
 * which `navigator.clipboard.writeText` needs: the copy buttons — a reply's
 * prose (ADR 0072 §3), a file's path or a commit's SHA in the viewer — write
 * through it, and nothing reads the clipboard back (the READ permission
 * stays denied). Chromium sanitizes what a page writes this way.
 *
 * Found 2026-09-30: with everything denied, the copy button's write rejected
 * with NotAllowedError and the button's own catch hid it, so the shipped
 * feature never reached the clipboard. The lab and the test had both
 * replaced `writeText` with a spy.
 */
export function rendererPermissionAllowed(permission: string): boolean {
  return permission === "clipboard-sanitized-write";
}
