import type { ReactNode } from "react";

export function Badge({ className, children }: { className?: string; children?: ReactNode }) {
  return <i className={className}>{children}</i>;
}
