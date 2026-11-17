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

const ALIASES: Record<keyof LeadMapping, string[]> = {
  email: ["email", "Email", "EMAIL"],
  first_name: ["first_name", "First Name", "FirstName"],
  last_name: ["last_name", "Last Name", "LastName"],
  company: ["company", "Company"],
  title: ["title", "Title"],
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

/** The column each identity field should read, by name or by its usual aliases. */
export function detectMapping(headers: string[]): LeadMapping {
  const found: LeadMapping = {};
  for (const field of Object.keys(ALIASES) as (keyof LeadMapping)[]) {
    const hit = headers.find((header) => ALIASES[field].includes(header.trim()));
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
