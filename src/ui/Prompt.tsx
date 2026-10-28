import { useState } from "react";

type PromptProps = {
  title: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

/** Single-field entry dialog, used when a name is needed before creating. */
export function Prompt({ title, placeholder, confirmLabel = "Create", onSubmit, onCancel }: PromptProps) {
  const [value, setValue] = useState("");
  const name = value.trim();

  return (
    <div className="confirm" onMouseDown={onCancel}>
      <form
        className="confirm-card"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name) onSubmit(name);
        }}
      >
        <h3>{title}</h3>
        <input
          className="prompt-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
