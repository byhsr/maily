import { AlertTriangle, ShieldCheck } from "lucide-react";
import { LEVEL_LABEL, type SpamScore } from "../lib/spam";
import { Tooltip } from "./Tooltip";

type SpamChipProps = {
  score: SpamScore;
  /** Press to toggle the reasons panel; omit for a chip that is only a readout. */
  onClick?: () => void;
  /** Whether the panel this chip opens is showing. */
  active?: boolean;
};

/**
 * A one-line readout of a message's spam risk. The tooltip names what tripped it, so the
 * number is never the only thing to go on.
 */
export function SpamChip({ score, onClick, active }: SpamChipProps) {
  const reasons = score.flags.length ? score.flags.map((flag) => flag.label).join(" · ") : "Nothing flagged";
  return (
    <Tooltip label={`${LEVEL_LABEL[score.level]} — ${reasons}`}>
      <button
        type="button"
        className={`spamchip level-${score.level}${active ? " on" : ""}`}
        onClick={onClick}
        aria-label={`Spam score ${score.score} of 100, ${LEVEL_LABEL[score.level]}`}
      >
        {score.level === "clean" ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
        Spam {score.score}
      </button>
    </Tooltip>
  );
}

/** The reasons behind a score: one line per flag, with the weight it cost. */
export function SpamPanel({ score }: { score: SpamScore }) {
  if (score.flags.length === 0) {
    return <p className="spamclean">Nothing in this message reads as spam to a filter.</p>;
  }
  return (
    <ul className="spamflags">
      {score.flags.map((flag) => (
        <li key={flag.id}>
          <b>{flag.label}</b>
          <span>{flag.detail}</span>
          <i>+{flag.weight}</i>
        </li>
      ))}
    </ul>
  );
}
