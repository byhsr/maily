/**
 * The zones Maily offers, named the way someone looking for one would say it. Each is an
 * IANA name, so the platform's own timezone database resolves it — daylight saving included
 * — rather than a table we would have to keep in step by hand.
 */
export type ZoneOption = { id: string; label: string };

export const ZONES: ZoneOption[] = [
  { id: "Asia/Kolkata", label: "India" },
  { id: "Asia/Dubai", label: "UAE" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Europe/London", label: "UK" },
  { id: "Europe/Paris", label: "Central Europe" },
  { id: "America/New_York", label: "USA — Eastern" },
  { id: "America/Chicago", label: "USA — Central" },
  { id: "America/Denver", label: "USA — Mountain" },
  { id: "America/Los_Angeles", label: "USA — Pacific" },
  { id: "Australia/Sydney", label: "Australia — Eastern" },
];

const pad = (value: number) => String(value).padStart(2, "0");

/** Minutes east of UTC for a zone at a moment, read from the platform's tz database. */
export function offsetMinutes(zone: string, at: Date = new Date()): number {
  const there = new Date(at.toLocaleString("en-US", { timeZone: zone }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((there.getTime() - utc.getTime()) / 60000);
}

/** "UTC+5:30", "UTC-4", "UTC+0". */
export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${pad(rest)}` : ""}`;
}

/** A zone's name and its offset together, for a picker's label. */
export function zoneLabel(zone: string): string {
  const known = ZONES.find((one) => one.id === zone);
  return `${known?.label ?? zone} · ${offsetLabel(offsetMinutes(zone))}`;
}

/**
 * The instant a wall-clock date and time means in a zone, which is what gets stored: the
 * sender then compares against an absolute moment and needs no timezone database of its own.
 * One pass of the offset is right everywhere except the hour a zone changes over.
 */
export function zonedInstant(date: string, time: string, zone: string): string {
  const naive = new Date(`${date}T${time}:00Z`);
  const offset = offsetMinutes(zone, naive);
  return new Date(naive.getTime() - offset * 60000).toISOString();
}

/** "9 Nov, 09:00" where the schedule was set — the same instant, read back in its zone. */
export function inZone(instant: string, zone?: string | null): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(zone ? { timeZone: zone } : {}),
  });
}
