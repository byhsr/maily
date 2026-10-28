import type { CSSProperties } from "react";

/**
 * Single source of truth for the canvas design system.
 *
 * Dark "AI workflow tool" aesthetic: near-black canvas, charcoal cards, one
 * colour per meaning (green = success/output, red = negative, gray = neutral)
 * and pastel pills for live state. Everything the canvas renders reads from
 * here, so the look can be retuned in one place.
 */
export const theme = {
  canvas: {
    bg: "#0B0B0C",
    bgAlt: "#111112",
    dot: "#232327",
    glow: "rgba(236, 72, 153, 0.14)",
  },
  card: {
    bg: "#1A1A1C",
    border: "rgba(255, 255, 255, 0.08)",
    borderHover: "rgba(255, 255, 255, 0.18)",
    borderSelected: "rgba(255, 255, 255, 0.55)",
    radius: 13,
    shadow: "0 10px 26px rgba(0, 0, 0, 0.45)",
    shadowHover: "0 14px 32px rgba(0, 0, 0, 0.55)",
    lift: -2,
  },
  input: {
    bg: "#121213",
    border: "rgba(255, 255, 255, 0.06)",
    radius: 8,
    placeholder: "#5C5C63",
    ink: "#EDEDF0",
  },
  text: {
    primary: "rgba(255, 255, 255, 0.92)",
    secondary: "#8A8A90",
    muted: "#6A6A70",
  },
  port: {
    size: 8,
    out: "#C9C9CE",
    neg: "#FF6B6B",
    neutral: "#6A6A70",
    ring: "rgba(11, 11, 12, 0.9)",
  },
  edge: {
    rest: "rgba(255, 255, 255, 0.4)",
    active: "rgba(255, 255, 255, 0.9)",
    width: 1.5,
  },
  accent: {
    run: "#E7E7EA",
    runInk: "#0B0B0C",
  },
  pill: {
    yellow: { bg: "#F5D76E", ink: "#1A1A1C" },
    pink: { bg: "#F7A8D8", ink: "#1A1A1C" },
    blue: { bg: "#8AC7FF", ink: "#1A1A1C" },
    green: { bg: "#7CFFB2", ink: "#0B0B0C" },
    red: { bg: "#FF6B6B", ink: "#0B0B0C" },
    gray: { bg: "#3A3A40", ink: "#EDEDF0" },
  },
} as const;

export type PillTone = keyof typeof theme.pill;

/** Status colour used by the results table and node state pills. */
export const STATUS_TONE: Record<string, PillTone> = {
  Positive: "green",
  Replied: "blue",
  "Not interested": "red",
  "No reply": "gray",
  Pending: "yellow",
  Sending: "pink",
  Unsubscribed: "red",
};

export const toneFor = (status: string): PillTone =>
  STATUS_TONE[status] ?? (status.startsWith("Waiting") ? "pink" : "gray");

/** Node-type accents keep the canvas scannable without adding much colour. */
const ACCENTS: Record<string, string> = {
  audience: "#9FA0A6",
  settings: "#9FA0A6",
  email: "#9FA0A6",
  wait: "#9FA0A6",
  followup: "#9FA0A6",
  classifier: "#9FA0A6",
  action: "#9FA0A6",
  results: "#6A6A70",
  // Legacy node types stay themed so older graphs still render.
  start: "#9FA0A6",
  delay: "#9FA0A6",
  condition: "#9FA0A6",
  end: "#6A6A70",
};

export const nodeAccent = (type: string): string => ACCENTS[type] ?? theme.text.secondary;

/** Expose the palette as CSS variables so stylesheets stay token-driven. */
export function canvasVars(): CSSProperties {
  return {
    "--cv-bg": theme.canvas.bg,
    "--cv-bg-alt": theme.canvas.bgAlt,
    "--cv-dot": theme.canvas.dot,
    "--cv-glow": theme.canvas.glow,
    "--cv-card": theme.card.bg,
    "--cv-card-line": theme.card.border,
    "--cv-card-line-hover": theme.card.borderHover,
    "--cv-card-line-sel": theme.card.borderSelected,
    "--cv-card-radius": `${theme.card.radius}px`,
    "--cv-card-shadow": theme.card.shadow,
    "--cv-card-shadow-hover": theme.card.shadowHover,
    "--cv-input": theme.input.bg,
    "--cv-input-line": theme.input.border,
    "--cv-input-radius": `${theme.input.radius}px`,
    "--cv-ink": theme.text.primary,
    "--cv-ink-2": theme.text.secondary,
    "--cv-ink-3": theme.text.muted,
    "--cv-port-out": theme.port.out,
    "--cv-port-neg": theme.port.neg,
    "--cv-port-neutral": theme.port.neutral,
    "--cv-edge": theme.edge.rest,
    "--cv-edge-active": theme.edge.active,
    "--cv-run": theme.accent.run,
    "--cv-run-ink": theme.accent.runInk,
  } as CSSProperties;
}
