import { ChevronDown } from "lucide-react";

type FilterChipProps = {
  label: string;
  value?: string;
  options?: string[];
  onChange?: (value: string) => void;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function FilterChip({ label, value, options, onChange, active, disabled, onClick }: FilterChipProps) {
  if (disabled) {
    return (
      <span className="chip chip-off" aria-disabled="true" title={`${label} filter has no data source yet`}>
        <span>
          {label}: {value}
        </span>
        <ChevronDown />
      </span>
    );
  }

  if (options && onChange) {
    return (
      <label className="chip chip-select">
        <span>
          {label}: {value}
        </span>
        <ChevronDown />
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <button className={active ? "chip on" : "chip"} onClick={onClick}>
      {label}
    </button>
  );
}
