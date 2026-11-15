import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export type OverflowItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** The one item that destroys: it is the only one that takes the danger colour. */
  danger?: boolean;
  /** A rule above this item, for separating a destructive choice from the rest. */
  divider?: boolean;
};

type OverflowMenuProps = {
  /** Names the trigger for screen readers, e.g. "Campaign actions". */
  label: string;
  items: OverflowItem[];
  className?: string;
};

const PANEL_W = 200;
const ITEM_H = 32;

/**
 * The "..." menu. Same transient grammar as every other menu in the app: one trigger, one
 * panel portalled to the body (so no ancestor's overflow can clip it), clamped to the
 * viewport, opening upward when it would run off the bottom, dismissed by an outside
 * mousedown or Escape. Depth comes from surface and border, never a shadow ramp.
 */
export function OverflowMenu({ label, items, className }: OverflowMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);

  useEffect(() => {
    if (!at) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".cardmenu") || trigger.current?.contains(target)) return;
      setAt(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAt(null);
        trigger.current?.focus();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, PANEL_W);
    const height = items.length * ITEM_H + 12;
    setAt({
      // Anchored to the trigger's right edge, which is where a "..." menu belongs.
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: rect.bottom - 6,
      width,
      up: rect.bottom + height > window.innerHeight,
    });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={["btn-icon", className].filter(Boolean).join(" ")}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => (at ? setAt(null) : open())}
      >
        <MoreHorizontal size={16} />
      </button>
      {at &&
        createPortal(
          <div
            className="cardmenu"
            role="menu"
            aria-label={label}
            style={{
              left: at.left,
              top: at.top,
              width: at.width,
              transform: at.up ? "translateY(-100%)" : undefined,
            }}
          >
            {items.map((item) => (
              <div key={item.label}>
                {item.divider && <hr />}
                <button
                  type="button"
                  role="menuitem"
                  className={item.danger ? "danger" : undefined}
                  onClick={() => {
                    setAt(null);
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
