import { describe, expect, it } from "vitest";
import { isValidEmail, missingVariables, renderVariables, sendEstimate, templateVariables } from "./logic";

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
  it("reads a cap as a ceiling, not as a rate spread across the clock", () => {
    // 42 leads at 30 an hour is about an hour's work, and it fits inside a 50-a-day cap
    // comfortably. Read as a rate, the same numbers came out as 20 hours.
    expect(sendEstimate(42, 30, 0, 50)).toBe("1h");
    // No caps at all: the pace alone decides.
    expect(sendEstimate(42, 12, 0, 0)).toBe("4h");
  });
  it("turns to days only when a day cannot hold the audience", () => {
    // A day holds min(720 at the pace, 50 the account allows) = 50 of the thousand.
    expect(sendEstimate(1000, 30, 0, 50)).toBe("20d");
    // The campaign's own cap is the lower of the two ceilings.
    expect(sendEstimate(42, 30, 20, 50)).toBe("3d");
    // With no caps, the pace is its own ceiling: 30 an hour is 720 a day.
    expect(sendEstimate(1000, 30, 0, 0)).toBe("2d");
  });
});
