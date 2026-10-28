import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "ghost" | "ink" | "icon";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "lime",
  ghost: "ghost",
  ink: "ink",
  icon: "round",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children?: ReactNode;
};

export function Button({ variant = "primary", className, children, ...rest }: ButtonProps) {
  const cls = [VARIANT_CLASS[variant], className].filter(Boolean).join(" ");
  return (
    <button className={cls || undefined} {...rest}>
      {children}
    </button>
  );
}
