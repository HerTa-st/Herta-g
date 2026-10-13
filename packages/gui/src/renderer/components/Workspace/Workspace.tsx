import { useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useSessionLang } from "../../hooks/useActiveSession.js";
import { useDisconnected } from "../../hooks/useDisconnected.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import {
  LocaleProvider,
  makeT,
  useLocale,
  useT,
} from "../../i18n/LocaleProvider.js";
import { ApprovalPanel } from "../Approval/ApprovalPanel.js";
import { Composer } from "./Composer.js";
import { ConnectStation } from "./ConnectStation.js";
import { Conversation } from "./Conversation.js";
import { LightboxProvider } from "./ImageLightbox.js";
import { SendArrowIcon } from "./SendArrowIcon.js";
import { useConnectMorph } from "./useConnectMorph.js";
import { useReconnectMorph } from "./useReconnectMorph.js";
import { useWorkspaceRefs, WorkspaceRefsProvider } from "./WorkspaceRefs.js";

function WorkspaceInner(): JSX.Element {
  const t = useT();
  const { overlayRef } = useWorkspaceRefs();
  const disconnected = useDisconnected();
  // Selector-based: the workspace shell only needs the connected-ness edge,
  // not a re-render per streaming delta.
  const connected = useSessionSelector((s) => s.sessionId !== null);
  const reduced = useReducedMotion();
  const { morphing, cloneRef } = useConnectMorph({
    disconnected,
    reduced,
    connected,
  });
  const reconnect = useReconnectMorph({ disconnected, reduced });
  // Track whether the disconnect we're currently showing arrived via a morph.
  // Set true whenever a morph is in flight; the static ConnectStation reads it
  // on the same render the morph settles (`disconnected && !morphing`) to skip
  // its `connectIn` entrance — the flying clone already played the entrance, so
  // replaying it would flash a visible dip right after the clone lands. Reset
  // when we leave the disconnected state so a later non-morph disconnect (e.g.
  // launch-disconnected) keeps its entrance.
  const arrivedViaMorph = useRef(false);
  if (morphing) arrivedViaMorph.current = true;
  if (!disconnected) arrivedViaMorph.current = false;
  // The conversation pane speaks the session's language, the app's chrome
  // the app's (owner, 2026-10-13: an English session in the Chinese app
  // showed 消息正在穿越银河 and a 请求权限 card; ADR 0019 amendment). The
  // last session's language is kept for the composer that turns into the
  // connect button as the session goes, so the riser carries the same words.
  const app = useLocale();
  const sessionLang = useSessionLang();
  const lastPaneLang = useRef(app.locale);
  if (connected) lastPaneLang.current = sessionLang;
  const paneLang = connected ? sessionLang : lastPaneLang.current;
  const paneT = useMemo(() => makeT(paneLang), [paneLang]);
  const cls = `workspace${morphing ? " is-morphing" : ""}${reconnect.reconnecting ? " is-reconnecting" : ""}${reconnect.revealing ? " is-revealing" : ""}`;
  return (
    <main className={cls} data-testid="workspace">
      <LocaleProvider locale={paneLang} onLocaleChange={app.setLocale}>
        <Conversation />
        <div className="workspace-footer">
          <Composer />
          <ApprovalPanel />
        </div>
      </LocaleProvider>
      {/* The static button is withheld until the morph settles (`!morphing`),
          so the flying clone hands off to it at the centre with no re-fade.
          Under reduced motion `morphing` is always false → A5's swap. When the
          button arrives FROM a morph, suppress its `connectIn` entrance so the
          hand-off is seamless (the clone already did the entrance). Also withheld
          while the reconnect clone is in flight so the clone hands off cleanly. */}
      <ConnectStation
        show={disconnected && !morphing && !reconnect.reconnecting}
        instant={arrivedViaMorph.current}
        instantExit={reconnect.reconnecting}
        onConnect={reconnect.begin}
        onConnectFailed={reconnect.cancel}
      />
      <div ref={overlayRef} className="morph-overlay" aria-hidden="true" />
      {/* The composer→button riser: a single div styled like the composer at
          mount — carrying the composer's content (placeholder + send) so the
          rise reads as the composer becoming the button — CSS-cross-fading to
          the centred label while useConnectMorph drives its left/top across the
          workspace and `.is-target` transitions its shape/colour to the ink
          button. */}
      {morphing &&
        overlayRef.current !== null &&
        createPortal(
          <div
            ref={cloneRef}
            className="connect-morph-clone"
            aria-hidden="true"
          >
            <div className="connect-morph-clone-input" aria-hidden="true">
              <span className="connect-morph-clone-placeholder">
                {paneT("composer.placeholder")}
              </span>
              <span className="connect-morph-clone-send">
                <SendArrowIcon />
              </span>
            </div>
            <span className="connect-morph-clone-label">
              {t("connect.button")}
            </span>
          </div>,
          overlayRef.current,
        )}
      {/* The clone flies INSIDE a right/bottom-anchored frame (the send
          button's constant insets from the overlay corner), so the flight,
          the landed wait, and the reveal all ride layout changes — grid
          collapse, sidebar toggle, window resize — exactly like the real
          button (user insight 2026-07-14). */}
      {reconnect.reconnecting &&
        overlayRef.current !== null &&
        createPortal(
          <div
            ref={reconnect.anchorRef}
            className="reconnect-morph-anchor"
            aria-hidden="true"
          >
            <div ref={reconnect.cloneRef} className="reconnect-morph-clone">
              <span className="reconnect-morph-clone-label">
                {t("connect.button")}
              </span>
              <span className="reconnect-morph-clone-arrow">
                <SendArrowIcon />
              </span>
            </div>
          </div>,
          overlayRef.current,
        )}
    </main>
  );
}

export function Workspace(): JSX.Element {
  return (
    <WorkspaceRefsProvider>
      {/* Click-to-enlarge for attached pictures (ADR 0048 §4a): both the
          conversation thumbs and the composer strip open the same viewer. */}
      <LightboxProvider>
        <WorkspaceInner />
      </LightboxProvider>
    </WorkspaceRefsProvider>
  );
}
