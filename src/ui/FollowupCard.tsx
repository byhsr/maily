import { GripVertical, Trash2 } from "lucide-react";
import { scoreMessage } from "../lib/spam";
import { SpamChip } from "./SpamScore";
import { Select } from "./Select";

/** One follow-up, as the composer and a campaign's setup both hold it. */
export type FollowupStep = {
  delay_days: number;
  body_md: string;
  /** The step's own subject. Blank means it goes out as a reply in the first touch's
   *  thread, which is what most follow-ups want. */
  subject_override?: string;
  /** 'YYYY-MM-DD' pins the step to a day, which overrides `delay_days`. */
  send_date?: string | null;
};

type FollowupCardProps = {
  step: FollowupStep;
  /** What this step is called, e.g. "Follow-up 1". */
  label: string;
  /** The first touch's subject, so the spam score reads the thread this step joins. */
  subject?: string;
  /** What the variables would be filled from, so a written variable is not scored as if it
   *  were going to send blank. */
  values?: Record<string, string | undefined>;
  /** When the step falls due, e.g. "in 3 days" — omitted where there is no anchor. */
  dueLabel?: string;
  onChange: (patch: Partial<FollowupStep>) => void;
  onRemove: () => void;
  /** A step something has already been sent to cannot change under the people who got it. */
  disabled?: boolean;
  /** Supplied by both callers: the card is dragged and reports where it landed. */
  onDragStart?: () => void;
  onDrop?: () => void;
};

/**
 * The follow-up step card. A single's follow-ups and a campaign's are the same object
 * written by the same person, so they are the same component: wait N days, write the
 * message, drag it where it belongs, delete it. A second grammar for one job is a defect.
 */
export function FollowupCard({
  step,
  label,
  subject,
  values,
  dueLabel,
  onChange,
  onRemove,
  disabled,
  onDragStart,
  onDrop,
}: FollowupCardProps) {
  const draggable = !!onDrop;
  // A step waits a number of days or sits on a calendar day; the sender treats a date as
  // the stronger of the two, so the control switches which one is set.
  const dated = !!step.send_date;

  /** The same wait, expressed as the day it would land on, so switching modes keeps intent. */
  const asDate = () => {
    const at = new Date();
    at.setDate(at.getDate() + Math.max(0, step.delay_days || 0));
    return at.toISOString().slice(0, 10);
  };

  return (
    <div
      className="fufcard"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={draggable ? (event) => event.preventDefault() : undefined}
      onDrop={onDrop}
    >
      <div className="fufcardhead">
        <span className="fufgrip" aria-hidden>
          <GripVertical size={14} />
        </span>
        <b>{label}</b>
        <SpamChip score={scoreMessage(step.subject_override || subject || "", step.body_md, values)} />
        <button
          type="button"
          className="btn-icon"
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="fufdelay">
        <Select
          ghost
          label={`How ${label.toLowerCase()} is timed`}
          value={dated ? "date" : "delay"}
          options={[
            { value: "delay", label: "Send after" },
            { value: "date", label: "Send on" },
          ]}
          onChange={(mode) => onChange({ send_date: mode === "date" ? asDate() : null })}
        />
        {dated ? (
          <input
            type="date"
            value={step.send_date ?? ""}
            disabled={disabled}
            aria-label={`The day ${label.toLowerCase()} goes out`}
            onChange={(event) => onChange({ send_date: event.target.value || null })}
          />
        ) : (
          <>
            <input
              type="number"
              min={0}
              max={365}
              value={step.delay_days}
              disabled={disabled}
              aria-label={`Days to wait before ${label.toLowerCase()}`}
              onChange={(event) => onChange({ delay_days: Number(event.target.value) || 0 })}
            />
            <span>days</span>
            {dueLabel && <small>({dueLabel})</small>}
          </>
        )}
      </div>

      <input
        className="fufsubject"
        type="text"
        value={step.subject_override ?? ""}
        disabled={disabled}
        aria-label={`${label} subject`}
        placeholder="Subject — blank continues the first email's"
        onChange={(event) => onChange({ subject_override: event.target.value })}
      />

      <textarea
        className="fuftext"
        value={step.body_md}
        disabled={disabled}
        aria-label={`${label} message`}
        placeholder="Write the follow-up in markdown..."
        onChange={(event) => onChange({ body_md: event.target.value })}
      />
    </div>
  );
}
