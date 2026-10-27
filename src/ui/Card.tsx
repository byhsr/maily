import type { ElementType, ReactNode } from "react";

type CardProps = {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
};

export function Card({ as: Tag = "article", className, children }: CardProps) {
  return <Tag className={className}>{children}</Tag>;
}
