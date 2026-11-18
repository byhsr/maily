import { useState } from "react";

type ConfirmProps = {
  title: string;
  message: string;
  confirmLabel?: string;
  /** A word the reader has to type before the button will do anything. Reserved for the handful
   *  of actions that cannot be undone and would take real work to put back. */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Lightweight destructive-action confirmation, shared across the app chrome. */
export function Confirm({
  title,
  message,
  confirmLabel = "Delete",
  requireText,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const [typed, setTyped] = useState("");
  // Case and stray spaces are not the point of the gate; having read the word is.
  const ready =
    !requireText || typed.trim().toLowerCase() === requireText.trim().toLowerCase();

  return (
    <div className="confirm" onMouseDown={onCancel}>
      <div className="confirm-card" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {requireText && (
          <label className="confirm-gate">
            <span>
              Type <b>{requireText}</b> to confirm
            </span>
            <input
              autoFocus
              className="prompt-input"
              value={typed}
              aria-label={`Type ${requireText} to confirm`}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready) onConfirm();
              }}
            />
          </label>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" disabled={!ready} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
