export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const VARIABLE = /{{\s*([\w.]+)(?:\s*\|\s*([^}]*))?\s*}}/g;

export function templateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) found.add(match[1]);
  return [...found];
}

export function renderVariables(template: string, values: Record<string, string | undefined>): string {
  return template.replace(VARIABLE, (_, key: string, fallback?: string) => {
    const value = values[key];
    return value !== undefined && value !== "" ? value : fallback ?? "";
  });
}

/** Variables that have neither a value nor an inline fallback (`{{name|default}}`). */
export function missingVariables(template: string, values: Record<string, string | undefined>): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) {
    const key = match[1];
    const fallback = match[2];
    const value = values[key];
    if ((value === undefined || value === "") && fallback === undefined) missing.add(key);
  }
  return [...missing];
}

/**
 * How long a campaign takes to send, as the setup form puts it: hours while the pace is
 * what decides, days once a day cannot hold the audience.
 *
 * The caps are ceilings rather than speeds. A campaign sends one email per interval and
 * stops for the day when it has spent its cap — so a cap of 50 a day against 42 leads is
 * still 42 sends at the pace, not a day's worth spread over the clock.
 */
export function sendEstimate(leads: number, perHour: number, cap: number, accountCap: number): string {
  const perDay = Math.max(1, Math.min(perHour * 24, cap || Number.POSITIVE_INFINITY, accountCap || Number.POSITIVE_INFINITY));
  if (leads <= perDay) return `${Math.max(1, Math.round(leads / perHour))}h`;
  return `${Math.ceil(leads / perDay)}d`;
}
