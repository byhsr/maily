import { Bold, Braces, Code, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import type { RefObject } from "react";
import { Tooltip } from "./Tooltip";

/**
 * Wraps whatever the textarea has selected in `before`/`after`, or the seed word when
 * nothing is selected. Reports false when the textarea is not on screen, which is how the
 * composer knows a tool press has to bring the message tab back first.
 *
 * The selection is read off the element rather than tracked in state, so the caret and the
 * scroll position are left exactly where the sender had them.
 */
export function wrapSelection(
  target: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (next: string) => void,
  before: string,
  after: string,
  seed = ""
): boolean {
  const element = target.current;
  if (!element) return false;
  const { selectionStart, selectionEnd } = element;
  const chosen = value.slice(selectionStart, selectionEnd) || seed;
  onChange(value.slice(0, selectionStart) + before + chosen + after + value.slice(selectionEnd));
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(selectionStart + before.length, selectionStart + before.length + chosen.length);
  });
  return true;
}

/**
 * Puts `marker` at the start of every line the selection touches, so a list is one press
 * for a paragraph and not a press per line. Reports false like `wrapSelection`.
 */
export function prefixSelectedLines(
  target: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (next: string) => void,
  marker: string
): boolean {
  const element = target.current;
  if (!element) return false;
  const { selectionStart, selectionEnd } = element;
  const from = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const block = value
    .slice(from, selectionEnd)
    .split("\n")
    .map((line) => marker + line)
    .join("\n");
  onChange(value.slice(0, from) + block + value.slice(selectionEnd));
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(from, from + block.length);
  });
  return true;
}

type FormatToolbarProps = {
  /** The markdown being edited, and the textarea it lives in. */
  target: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  /** A step that has already gone to someone cannot have its words changed. */
  disabled?: boolean;
  /** Called instead of editing when the textarea is not on screen. */
  onUnavailable?: () => void;
};

/**
 * The markdown tools: the emphasis, a link, the two lists, a quote, code, and the two
 * variables people reach for most. The message composer and a follow-up step share this
 * one set, because a follow-up is written by the same person as the message above it and a
 * second grammar for the same job is a defect.
 */
export function FormatToolbar({ target, value, onChange, disabled, onUnavailable }: FormatToolbarProps) {
  const wrap = (before: string, after: string, seed = "") => {
    if (!wrapSelection(target, value, onChange, before, after, seed)) onUnavailable?.();
  };
  const lines = (marker: string) => {
    if (!prefixSelectedLines(target, value, onChange, marker)) onUnavailable?.();
  };

  return (
    <div className="composerformat">
      <Tooltip label="Bold">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("**", "**", "bold")}>
          <Bold size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Italic">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("*", "*", "italic")}>
          <Italic size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Link">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("[", "](https://)", "text")}>
          <Link2 size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Bullet list">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => lines("- ")}>
          <List size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Numbered list">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => lines("1. ")}>
          <ListOrdered size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Quote">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => lines("> ")}>
          <Quote size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Code">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("`", "`", "code")}>
          <Code size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Insert a variable">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("", "", "{{first_name}}")}>
          <Braces size={16} />
        </button>
      </Tooltip>
      <Tooltip label="Insert the company variable">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => wrap("", "", "{{company}}")}>
          <span className="composervar">company</span>
        </button>
      </Tooltip>
    </div>
  );
}
