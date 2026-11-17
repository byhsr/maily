import { describe, expect, it } from "vitest";
import { detectEmailField, detectMapping, mapRowsWith } from "./leadImport";

describe("email detection", () => {
  it("finds the usual spellings of an email column", () => {
    const spellings = [
      "email",
      "Email",
      "E-mail",
      "Emails",
      "Email Address",
      "Work Email",
      "work-email",
      "WorkEmail",
      "Contact Email",
      "mail",
    ];
    for (const header of spellings) {
      expect(detectEmailField(["Name", header]), header).toBe(header);
    }
  });

  it("prefers the plain email column over a qualified one", () => {
    expect(detectEmailField(["Work Email", "Email"])).toBe("Email");
  });

  it("does not mistake a physical address or a name for an email", () => {
    expect(detectEmailField(["First Name", "Company", "Mailing Address"])).toBeUndefined();
  });

  it("maps names and company alongside the email", () => {
    const mapping = detectMapping(["First Name", "Last Name", "Company Name", "Work Email"]);
    expect(mapping).toEqual({
      email: "Work Email",
      first_name: "First Name",
      last_name: "Last Name",
      company: "Company Name",
    });
  });

  it("keeps the whole row and drops rows with no email", () => {
    const rows = mapRowsWith(
      [
        { "Work Email": "a@b.com", City: "Berlin" },
        { "Work Email": "", City: "Oslo" },
      ],
      "Imported",
      { email: "Work Email" }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("a@b.com");
    expect(rows[0].custom_fields).toEqual({ "Work Email": "a@b.com", City: "Berlin" });
  });
});
