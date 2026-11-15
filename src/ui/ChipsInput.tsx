import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { isValidEmail } from "../lib/logic";

type ChipsInputProps = {
  values: string[];
  onChange: (values: string[]) => void;
  label: string;
  placeholder?: string;
};

/**
 * An address field: each address becomes a chip. Enter and comma commit, a paste of a
 * whole list becomes several chips, and Backspace on an empty field takes the last one
 * back. An address that does not look like one stays visible in red rather than being
 * silently dropped.
 */
export function ChipsInput({ values, onChange, label, placeholder }: ChipsInputProps) {
  const [entry, setEntry] = useState("");

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    setEntry("");
    if (parts.length === 0) return;
    const next = [...values];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(entry);
    } else if (event.key === "Backspace" && !entry && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    // A pasted list is the common case; a single address is left for the user to commit.
    if (/[,;\s]/.test(text.trim())) {
      event.preventDefault();
      commit(text);
    }
  };

  return (
    <div className="chipsinput">
      {values.map((value) => (
        <span key={value} className={`addresschip${isValidEmail(value) ? "" : " bad"}`}>
          {value}
          <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((one) => one !== value))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={entry}
        aria-label={label}
        className={entry && !isValidEmail(entry) ? "bad" : undefined}
        placeholder={values.length ? "" : placeholder}
        onChange={(event) => setEntry(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(entry)}
      />
    </div>
  );
}
