import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  text: string;
  action?: () => void;
  label?: ReactNode;
};

export function EmptyState({ text, action, label = "Get started" }: EmptyStateProps) {
  return (
    <div className="blank">
      <p>{text}</p>
      <button onClick={action}>
        {label} <ChevronRight />
      </button>
    </div>
  );
}
