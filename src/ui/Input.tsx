import type { InputHTMLAttributes, Ref } from "react";

/** `ref` is passed straight through (React 19 forwards it as a plain prop), so a field the
 *  variable picker anchors to can hold the element it needs. */
export function Input({
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} />;
}
