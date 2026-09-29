import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";

/** Leave-animation duration; the `cardMenuOut` keyframe's. */
export const SESSION_MENU_EXIT_MS = 120;

/** Space kept between the menu and the window's edge. */
const EDGE = 8;

/** Why the menu closed: an Escape or a Tab hands focus back to the card; a
 *  pick moves it on; a press elsewhere leaves it where the press put it. */
export type SessionMenuCloseReason = "escape" | "pick" | "outside";

export interface SessionMenuProps {
  /** Where it opened: the pointer, or the card's corner from the keyboard. */
  readonly at: { readonly x: number; readonly y: number };
  /** Playing its exit: the menu takes no input. */
  readonly leaving: boolean;
  /** Each item shows only when its handler is given (the bridge has the
   *  surface). */
  readonly onRename?: () => void;
  readonly onExport?: () => void;
  readonly onClose: (reason: SessionMenuCloseReason) => void;
}

/**
 * The sidebar session card's menu (ADR 0072 §3): rename, export. Opened by
 * a right-click, the context-menu key or Shift+F10 on the card.
 *
 * Dressed as the device card's menu (the app's other menu: a solid card,
 * the same items) and portaled to the body, fixed at the pointer and kept
 * inside the window. It is the topmost overlay while open, so its Escape
 * never reaches the approval panel behind it (overlay-stack.ts).
 *
 * React bubbles a portal's events through its React parent — the card,
 * whose click opens the session. The root stops them.
 */
export function SessionMenu(props: SessionMenuProps): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({
    top: props.at.y,
    left: props.at.x,
  });
  const isTop = useModalOverlay(
    "session-menu",
    !props.leaving,
    OVERLAY_Z.cardMenu,
  );
  const { onClose } = props;

  // Keep it inside the window: flip up or left when the pointer is near an
  // edge. Measured once mounted, before the first paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left =
      props.at.x + w + EDGE > window.innerWidth
        ? Math.max(EDGE, props.at.x - w)
        : props.at.x;
    const top =
      props.at.y + h + EDGE > window.innerHeight
        ? Math.max(EDGE, props.at.y - h)
        : props.at.y;
    setPlace({ top, left });
  }, [props.at.x, props.at.y]);

  // The first item takes focus, so the keyboard can act at once.
  useEffect(() => {
    if (props.leaving) return;
    ref.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']")
      ?.focus({ preventScroll: true });
  }, [props.leaving]);

  // Dismissed by a press anywhere else, a scroll, a resize, the window
  // losing focus.
  useEffect(() => {
    if (props.leaving) return;
    const onDown = (e: MouseEvent): void => {
      if (!(ref.current?.contains(e.target as Node) ?? false)) {
        onClose("outside");
      }
    };
    const close = (): void => onClose("outside");
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [props.leaving, onClose]);

  const pick = (action: (() => void) | undefined): void => {
    onClose("pick");
    action?.();
  };

  return createPortal(
    <div
      ref={ref}
      className={`card-menu-tooltip card-menu-tooltip--floating session-menu${
        props.leaving ? " is-leaving" : ""
      }`}
      style={place}
      role="menu"
      aria-label={t("session.menuAria")}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          if (!isTop) return;
          e.preventDefault();
          onClose("escape");
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          onClose("escape");
          return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>(
            "[role='menuitem']",
          ) ?? []),
        ];
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          e.key === "ArrowDown"
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}
    >
      {props.onRename !== undefined && (
        <button
          type="button"
          role="menuitem"
          className="card-menu-item"
          onClick={() => pick(props.onRename)}
        >
          {t("session.rename")}
        </button>
      )}
      {props.onExport !== undefined && (
        <button
          type="button"
          role="menuitem"
          className="card-menu-item"
          onClick={() => pick(props.onExport)}
        >
          {t("session.export")}
        </button>
      )}
    </div>,
    document.body,
  );
}
