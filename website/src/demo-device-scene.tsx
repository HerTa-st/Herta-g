/**
 * The site's stand-in for the 3D device scene. No 3D on the site (owner
 * 2026-09-10: "use flat device images instead of 3D models"): aliased over
 * `device-scene/DeviceScene.js` in vite.config.ts, this module imports
 * nothing heavy — the real one would emit the three.js scene chunk (1.1 MB)
 * and the Basis transcoder (585 KB) into every deploy.
 *
 * It shows a PICTURE of the scene: one of the four renders the desk section
 * already carries (src/assets/device-*.webp, the real scene through the
 * release film's driven mode), the night one in the dark theme and the
 * visitor's hour's in the light one. Until 2026-10-14 it reported "no
 * scene" and the card fell back to its flat renders — the device alone,
 * with no room around it, which is not how the app looks wherever a GPU
 * draws the scene (owner: "the device card lacks the background").
 */

import type { DeviceSceneProps } from "@gui/components/UtilityRail/device-scene/DeviceScene";
import { useState } from "react";
import deviceDusk from "./assets/device-dusk.webp";
import deviceMorning from "./assets/device-morning.webp";
import deviceNight from "./assets/device-night.webp";
import deviceNoon from "./assets/device-noon.webp";

/** The render for this theme and hour: 7:30, 12:30 and 18:30 in the light
 *  theme, 22:30 in the dark one — the hours the renders were made at. */
function stillFor(theme: DeviceSceneProps["theme"], hour: number): string {
  if (theme === "dark") return deviceNight;
  if (hour < 10) return deviceMorning;
  if (hour < 16) return deviceNoon;
  return deviceDusk;
}

export function DeviceScene(props: DeviceSceneProps): JSX.Element | null {
  const { onLive, theme } = props;
  // The posters (`?poster=1`) are one frame whenever they are shot: noon.
  const [hour] = useState(() =>
    new URLSearchParams(window.location.search).has("poster")
      ? 12
      : new Date().getHours(),
  );
  const src = stillFor(theme, hour);
  // Live once the picture is drawn; one that will not load leaves the card
  // on its flat renders, as a scene that cannot start does in the app.
  return (
    <img
      className="device-scene-canvas"
      src={src}
      alt=""
      aria-hidden="true"
      decoding="async"
      style={{ objectFit: "cover" }}
      onLoad={() => onLive(true)}
      onError={() => onLive(false)}
    />
  );
}
