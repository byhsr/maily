import { ChevronDown } from "lucide-react";
import { Select } from "./Select";

type FilterChipProps = {
  label: string;
  value?: string;
  options?: string[];
  onChange?: (value: string) => void;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

/**
 * A filter chip. A filter with choices wears the app's dropdown rather than a native
 * `<select>` — one dropdown grammar everywhere, and the chip geometry on top of it.
 */
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
      <Select
        className="chipselect"
        prefix={`${label}:`}
        label={label}
        value={value ?? options[0]}
        options={options.map((option) => ({ value: option, label: option }))}
        onChange={onChange}
      />
    );
  }

  return (
    <button className={active ? "chip on" : "chip"} onClick={onClick}>
      {label}
    </button>
  );
}
