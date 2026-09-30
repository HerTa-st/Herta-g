import type { RepoContextSnapshot } from "@herta/app-server";
import { useEffect } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  useSessionScoped,
  useSessionScopedTimer,
} from "../../hooks/useSessionScoped.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { CARD_SLIDE_MS } from "./card-motion.js";

/** Focus refreshes are throttled: a window that flickers focus (a dialog,
 *  an alt-tab and back) must not spawn a `git status` per flicker. */
export const REPO_FOCUS_REFRESH_MIN_MS = 2000;

/** Slack past the slide before the retracted card is dropped: unmounting
 *  late leaves a collapsed box a moment longer, unmounting early tears the
 *  content out mid-slide — so the timer deliberately runs long. (A
 *  `transitionend` listener never fires under reduced motion, where the
 *  transition is removed, and the card would then never unmount.) */
const REPO_UNMOUNT_SLACK_MS = 120;

export interface RepoCardState {
  /** The repository to draw, or null when the card should not be mounted. */
  readonly repo: RepoContextSnapshot | null;
  /** Whether the card should be slid OUT. */
  readonly open: boolean;
  /** A first answer has been on screen: later answers are CHANGES, and
   *  their rows may move (ADR 0058 §5.7). False again once the card has
   *  retracted, so a new repository's first answer arrives settled. */
  readonly settled: boolean;
}

/**
 * The rail repository card's state (ADR 0058), derived from the active
 * session: the store's last repository answer, kept through the slide-out
 * so the card retracts with its content and is dropped only after the
 * slide (the plan card's two phases). A window focus asks the session to
 * probe again — the user came back from a terminal or an editor, and that
 * is when a commit made outside the app should already be on the card.
 */
export function useRepoCard(): RepoCardState {
  const repo = useSessionSelector((s) => s.repo);
  const sessionId = useSessionSelector((s) => s.sessionId);
  const { bridge } = useHertaBridge();
  const [shown, setShown] = useSessionScoped<RepoContextSnapshot | null>(null);
  const [settled, setSettled] = useSessionScoped(false);
  const unmount = useSessionScopedTimer();

  useEffect(() => {
    if (repo !== null) {
      unmount.clear();
      setShown(repo);
      return;
    }
    setSettled(false);
    unmount.arm(() => setShown(null), CARD_SLIDE_MS + REPO_UNMOUNT_SLACK_MS);
  }, [repo, unmount, setShown, setSettled]);

  // Settled follows what is ON SCREEN (`shown`), one commit behind it: the
  // render that first draws the rows sees `settled` false and lands them
  // still; the effect then arms motion for the answers after it.
  useEffect(() => {
    if (shown !== null) setSettled(true);
  }, [shown, setSettled]);

  useEffect(() => {
    const refresh = bridge.refreshRepo;
    if (refresh === undefined || sessionId === null) return;
    let last = 0;
    const onFocus = (): void => {
      const now = Date.now();
      if (now - last < REPO_FOCUS_REFRESH_MIN_MS) return;
      last = now;
      void refresh.call(bridge).catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bridge, sessionId]);

  return { repo: shown, open: repo !== null, settled };
}
