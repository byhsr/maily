import * as XLSX from "xlsx";
import { upsertLeads } from "./api";

/** Which sheet column feeds which identity field. Every other column stays available to a
 *  message as a `{{variable}}`, so only the fields a send must address are mapped. */
export type LeadMapping = {
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
};

/** A header reduced to letters and digits, so "Work E-mail", "work_email" and "WorkEmail"
 *  are all one word and one comparison can see them as the same column. */
export function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The spellings an email column is known by, best first. A header that merely contains
 *  "email" (work email, billing email, e-mail…) is scored below these but still found. */
const EMAIL_ALIASES = [
  "email",
  "emails",
  "emailaddress",
  "emailaddr",
  "emailid",
  "workemail",
  "workmail",
  "businessemail",
  "contactemail",
  "primaryemail",
  "useremail",
  "mail",
];

/** How likely a header names the email column: higher is better, 0 means it is not one. */
export function emailScore(header: string): number {
  const key = headerKey(header);
  if (!key) return 0;
  const exact = EMAIL_ALIASES.indexOf(key);
  if (exact >= 0) return 100 - exact;
  if (key.startsWith("email")) return 80;
  if (key.endsWith("email")) return 70;
  if (key.includes("email")) return 60;
  return 0;
}

/** The best email column a set of headers offers, or undefined when none looks like one. */
export function detectEmailField(headers: string[]): string | undefined {
  let best: string | undefined;
  let score = 0;
  for (const header of headers) {
    const value = emailScore(header);
    if (value > score) {
      score = value;
      best = header;
    }
  }
  return best;
}

/** The other identity fields' usual spellings, compared after `headerKey`. */
const FIELD_ALIASES: Record<Exclude<keyof LeadMapping, "email">, string[]> = {
  first_name: ["firstname", "first", "givenname", "fname", "forename"],
  last_name: ["lastname", "last", "surname", "familyname", "lname"],
  company: ["company", "companyname", "organization", "organisation", "org", "employer", "accountname", "business"],
  title: ["title", "jobtitle", "role", "position", "jobrole", "designation"],
};

/** The header row, so a mapping step can offer the sheet's own columns. */
export async function readSheet(
  file: File
): Promise<{ headers: string[]; records: Record<string, unknown>[] }> {
  const raw = await file.arrayBuffer();
  const book = XLSX.read(raw, { type: "array" });
  const first = book.Sheets[book.SheetNames[0]];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(first, { defval: "" });
  const headers = records.length ? Object.keys(records[0] as object) : [];
  return { headers, records };
}

/** The column each identity field should read. The email column is whichever header looks
 *  most like an address; the rest match their usual spellings, whitespace and case ignored. */
export function detectMapping(headers: string[]): LeadMapping {
  const found: LeadMapping = {};
  const email = detectEmailField(headers);
  if (email) found.email = email;
  for (const field of Object.keys(FIELD_ALIASES) as Exclude<keyof LeadMapping, "email">[]) {
    const aliases = FIELD_ALIASES[field];
    const hit = headers.find((header) => aliases.includes(headerKey(header)));
    if (hit) found[field] = hit;
  }
  return found;
}

/** Maps sheet rows to leads: the mapped columns are lifted, and the whole row is kept so
 *  any header becomes a `{{variable}}` at send time. Rows with no email are dropped. */
export function mapRowsWith(
  records: Record<string, unknown>[],
  listName: string,
  mapping: LeadMapping
) {
  const at = (row: Record<string, unknown>, field: keyof LeadMapping) => {
    const column = mapping[field];
    return column ? String(row[column] ?? "") : "";
  };
  return records
    .map((row) => ({
      email: at(row, "email").trim(),
      first_name: at(row, "first_name"),
      last_name: at(row, "last_name"),
      company: at(row, "company"),
      title: at(row, "title"),
      list_name: listName,
      // The whole file arrives together, so these are a list rather than a crowd of
      // individuals: the Leads page shows the list and its count.
      source: "import",
      custom_fields: row,
    }))
    .filter((row) => row.email);
}

/** Imports an already-parsed sheet into one named list under the given mapping. */
export const importMapped = (
  records: Record<string, unknown>[],
  listName: string,
  mapping: LeadMapping
): Promise<number> => upsertLeads(mapRowsWith(records, listName, mapping));

/** Reads a CSV/XLSX file and upserts its rows into one named list. Returns the row count. */
export async function importLeads(file: File, listName: string): Promise<number> {
  const { headers, records } = await readSheet(file);
  return importMapped(records, listName, detectMapping(headers));
}
