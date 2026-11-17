import { useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { Input } from "./Input";

/** Either field the picker can be anchored to — a message body or a subject line. */
export type VariableField = HTMLInputElement | HTMLTextAreaElement;

/** The `{{` a caret is sitting inside, if any: where it opened and what has been typed after
 *  it. A `}` or a newline closes the door — the token is done, or was never one. */
function openToken(value: string, caret: number): { start: number; partial: string } | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start === -1) return null;
  const between = before.slice(start + 2);
  if (between.includes("}") || between.includes("\n")) return null;
  return { start, partial: between };
}

export type VariableSuggest = {
  open: boolean;
  matches: string[];
  index: number;
  /** Call after the field changes, with the element, to work out what to offer. */
  sync: (element: VariableField) => void;
  /** Replace the half-typed token with a complete one. */
  choose: (element: VariableField | null, key: string) => void;
  /** Handle the arrows, Enter/Tab and Escape while the list is open. */
  onKeyDown: (element: VariableField, event: KeyboardEvent<VariableField>) => void;
};

/**
 * Offers the variables a message can use as soon as `{{` is typed, drawn from the audience
 * being written to rather than a list written down here, so a token cannot be half-remembered
 * into a send that blocks.
 */
export function useVariableSuggest(
  variables: string[],
  onChange: (next: string) => void
): VariableSuggest {
  const [token, setToken] = useState<{ start: number; partial: string; caret: number } | null>(null);
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    if (!token) return [];
    const needle = token.partial.trim().toLowerCase();
    const found = needle
      ? variables.filter((key) => key.toLowerCase().includes(needle))
      : variables;
    return found.slice(0, 8);
  }, [token, variables]);

  const sync = (element: VariableField) => {
    const found = openToken(element.value, element.selectionStart ?? 0);
    setToken(found ? { ...found, caret: element.selectionStart ?? 0 } : null);
    setIndex(0);
  };

  const choose = (element: VariableField | null, key: string) => {
    if (!token || !element) return;
    const insert = `{{${key}}}`;
    onChange(element.value.slice(0, token.start) + insert + element.value.slice(token.caret));
    const caret = token.start + insert.length;
    setToken(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (element: VariableField, event: KeyboardEvent<VariableField>) => {
    if (!token || matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((at) => (at + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((at) => (at - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(element, matches[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setToken(null);
    }
  };

  return { open: !!token && matches.length > 0, matches, index, sync, choose, onKeyDown };
}

/** The list itself, anchored under the field it belongs to. */
export function VariableMenu({
  suggest,
  onPick,
}: {
  suggest: VariableSuggest;
  onPick: (key: string) => void;
}) {
  if (!suggest.open) return null;
  return (
    <div className="varmenu" role="listbox" aria-label="Variables">
      {suggest.matches.map((key, at) => (
        <button
          type="button"
          role="option"
          aria-selected={at === suggest.index}
          className={at === suggest.index ? "on" : undefined}
          key={key}
          onMouseDown={(event) => {
            // Keep the caret in the field: the pick must not blur it first.
            event.preventDefault();
            onPick(key);
          }}
          onClick={(event) => event.preventDefault()}
        >
          {`{{${key}}}`}
        </button>
      ))}
    </div>
  );
}

type VariableInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  variables: string[];
  value: string;
  onChange: (next: string) => void;
};

/** One line of text that offers the audience's variables as `{{` is typed — the subject
 *  line the body's picker had no counterpart for. */
export function VariableInput({ variables, value, onChange, ...rest }: VariableInputProps) {
  const field = useRef<HTMLInputElement>(null);
  const suggest = useVariableSuggest(variables, onChange);
  return (
    <div className="varfield">
      <Input
        {...rest}
        ref={field}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          suggest.sync(event.target);
        }}
        onKeyDown={(event) => suggest.onKeyDown(event.currentTarget, event)}
      />
      <VariableMenu suggest={suggest} onPick={(key) => suggest.choose(field.current, key)} />
    </div>
  );
}
