import { useSyncExternalStore } from "react";
import type { HertaBridge } from "../../../ipc/bridge-types.js";

/**
 * Whether this host draws the 3D device card (ADR 0057), read once per
 * renderer lifetime. The desktop answers true; whether THIS machine's GPU can
 * is the card's own probe. It was a Settings toggle until 2026-10-01 (§2.7
 * amended: the owner made the lit device the only choice, with the flat art
 * wherever the GPU does not allow it).
 *
 *   null   — unknown yet, or the bridge has no surface for it (fakes, the
 *            website demo): the card keeps its flat renders.
 *   bool   — the host's answer.
 */
export type DeviceScenePref = boolean | null;

let value: DeviceScenePref = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: DeviceScenePref): void {
  if (next === value) return;
  value = next;
  for (const l of listeners) l();
}

export function deviceScenePref(): DeviceScenePref {
  return value;
}

export function subscribeDeviceScenePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the persisted value once per renderer lifetime. Idempotent: the card
 * and the Settings pane both call it on mount and share the one round-trip.
 * A bridge without the surface resolves to null (the row hides, the card
 * stays flat); a failed read does the same rather than guessing.
 */
export function loadDeviceScenePref(bridge: HertaBridge): Promise<void> {
  if (loading !== null) return loading;
  const read = bridge.getDeviceScene;
  if (read === undefined) {
    set(null);
    loading = Promise.resolve();
    return loading;
  }
  loading = read
    .call(bridge)
    .then((v) => set(v === true))
    .catch(() => set(null));
  return loading;
}

/** React binding. */
export function useDeviceScenePref(): DeviceScenePref {
  return useSyncExternalStore(subscribeDeviceScenePref, deviceScenePref);
}

/** Test hook: forget the value and the in-flight load. */
export function resetDeviceScenePrefForTest(): void {
  value = null;
  loading = null;
  listeners.clear();
}
