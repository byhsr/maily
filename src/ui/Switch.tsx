type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Names the control when there is no visible label next to it. */
  label: string;
  children?: string;
};

/**
 * A 28x16 track with a 12px thumb. One button, so the label is part of the hit area and
 * there is no native checkbox anywhere in the Inbox.
 */
export function Switch({ checked, onChange, label, children }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={children ? undefined : label}
      className={`switchrow${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <i className="switch" />
      {children && <span>{children}</span>}
    </button>
  );
}
