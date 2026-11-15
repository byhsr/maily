type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
};

/** A 14px square. Never a native checkbox: those cannot be given our radius or tick. */
export function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`checkbox${checked ? " on" : ""}`}
      onClick={(event) => {
        // The row behind this is a button too; ticking the box must not open it.
        event.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}
