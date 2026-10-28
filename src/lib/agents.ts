export const AGENT_KIND_LABELS: Record<string, string> = {
  research: "Research",
  qualify: "Qualify",
  draft: "Draft email",
  followup: "Draft follow-up",
  classify_reply: "Classify reply",
  style_analysis: "Style analysis",
  followup_decision: "Follow-up decision",
};

export function agentKindLabel(kind: string): string {
  return AGENT_KIND_LABELS[kind] ?? kind;
}

/** Kinds whose output becomes an email draft for review. */
export function isDraftingKind(kind: string): boolean {
  return kind === "draft" || kind === "followup";
}

export function usageLabel(run: { cost?: number; prompt_tokens?: number; completion_tokens?: number }): string {
  const tokens = (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0);
  const parts: string[] = [];
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
  if (run.cost) parts.push(`$${run.cost.toFixed(4)}`);
  return parts.join(" · ");
}

export function whenLabel(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
