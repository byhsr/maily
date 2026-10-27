type FilterChipProps = {
  label: string;
  active?: boolean;
  onClick?: () => void;
};

export function FilterChip({ label, active, onClick }: FilterChipProps) {
  return (
    <button className={active ? "chip on" : "chip"} onClick={onClick}>
      {label}
    </button>
  );
}
