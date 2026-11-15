import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  /** A classification colour name, drawn as a dot in front of the label. */
  dot?: string;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Names the control for screen readers, and doubles as the empty fallback. */
  label: string;
  placeholder?: string;
  /** A bare trigger with no box, for use inside a row or a toolbar. */
  ghost?: boolean;
  className?: string;
  /** A muted leading label, so a filter can read "Status: All" on one line. */
  prefix?: string;
  /** Locked controls stay legible: disabled is an opacity, never a grey repaint. */
  disabled?: boolean;
};

const PANEL_W = 200;
const PANEL_H = 260;

/**
 * The app's dropdown. A native `<select>` cannot be styled past its box, so every
 * dropdown in the Inbox is this: one trigger, one portalled panel, the same keyboard
 * contract everywhere. Focus stays on the trigger, so the arrow keys keep working.
 */
export function Select({ value, options, onChange, label, placeholder = "Select", ghost, className, prefix, disabled }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const [active, setActive] = useState(0);

  const chosen = options.find((option) => option.value === value);

  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, PANEL_W);
    setAt({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.top - 6,
      width,
      // Flip above the trigger when the panel would run off the bottom of the window.
      up: rect.bottom + PANEL_H > window.innerHeight,
    });
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
  };

  useEffect(() => {
    if (!at) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".selectpanel") || anchorContains(target)) return;
      setAt(null);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [at]);

  const anchorContains = (target: Element | null) => !!target && !!trigger.current?.contains(target);

  const close = () => {
    setAt(null);
    trigger.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!at) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) {
        onChange(option.value);
        close();
      }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={[ghost ? "selectghost" : "select", at ? "on" : "", className].filter(Boolean).join(" ")}
        disabled={disabled}
        onClick={() => (at ? close() : open())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={!!at}
        aria-label={label}
      >
        {prefix && <span className="selectprefix">{prefix}</span>}
        {chosen?.dot && <i className={`dot dot-${chosen.dot}`} />}
        <span className="selectvalue">{chosen?.label ?? placeholder}</span>
        <ChevronDown size={14} className="selectchevron" />
      </button>
      {at &&
        createPortal(
          <div
            className="selectpanel"
            role="listbox"
            aria-label={label}
            style={{
              left: at.left,
              top: at.top,
              width: at.width,
              transform: at.up ? "translateY(-100%)" : undefined,
            }}
          >
            {options.length === 0 && <p className="selectempty">no options</p>}
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={["selectoption", index === active ? "on" : "", option.value === value ? "picked" : ""]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onChange(option.value);
                  close();
                }}
              >
                {option.dot && <i className={`dot dot-${option.dot}`} />}
                <span className="selectlabel">{option.label}</span>
                {option.value === value && <Check size={13} />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
