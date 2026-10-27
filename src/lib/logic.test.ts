import { describe, expect, it } from "vitest";
import { isValidEmail, missingVariables, renderVariables, templateVariables } from "./logic";

describe("outreach input helpers", () => {
  it("accepts conventional email addresses and rejects malformed input", () => {
    expect(isValidEmail("person@example.com")).toBe(true);
    expect(isValidEmail("not an email")).toBe(false);
  });
  it("renders only known message variables", () => {
    expect(renderVariables("Hi {{ first_name }} at {{company}}", { first_name: "Ada", company: "Acme" })).toBe("Hi Ada at Acme");
    expect(renderVariables("Hi {{unknown}}", {})).toBe("Hi ");
  });
  it("uses inline fallbacks when a value is missing", () => {
    expect(renderVariables("Hi {{first_name|there}}", {})).toBe("Hi there");
    expect(renderVariables("Hi {{first_name|there}}", { first_name: "Ada" })).toBe("Hi Ada");
  });
  it("lists template variables and flags the ones with no value or fallback", () => {
    expect(templateVariables("{{first_name}} and {{company|Acme}}")).toEqual(["first_name", "company"]);
    expect(missingVariables("Hi {{first_name}} at {{company|Acme}}", {})).toEqual(["first_name"]);
    expect(missingVariables("Hi {{first_name|there}}", {})).toEqual([]);
  });
});
