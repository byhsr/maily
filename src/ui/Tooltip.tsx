import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type TooltipProps = {
  label: string;
  children: ReactNode;
};

/**
 * The app's tooltip. The native `title` attribute is not used here: it cannot be styled,
 * it waits about a second, and it ignores every token. The panel is portalled so no
 * ancestor's overflow can clip it, and it sits above the anchor, clamped to the viewport.
 */
export function Tooltip({ label, children }: TooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // A scroll moves the anchor out from under the tooltip, so it goes away with it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setAt({ x: rect.left + rect.width / 2, y: rect.top - 6 });
  };

  return (
    <span
      ref={anchor}
      className="tipanchor"
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
    >
      {children}
      {at &&
        createPortal(
          <div className="tooltip" role="tooltip" style={{ left: `clamp(76px, ${at.x}px, calc(100vw - 76px))`, top: at.y }}>
            {label}
          </div>,
          document.body
        )}
    </span>
  );
}
