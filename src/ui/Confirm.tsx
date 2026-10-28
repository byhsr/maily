type ConfirmProps = {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Lightweight destructive-action confirmation, shared across the app chrome. */
export function Confirm({ title, message, confirmLabel = "Delete", onConfirm, onCancel }: ConfirmProps) {
  return (
    <div className="confirm" onMouseDown={onCancel}>
      <div className="confirm-card" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="confirm-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
