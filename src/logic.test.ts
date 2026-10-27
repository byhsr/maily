import { describe, expect, it } from "vitest";
import { isValidEmail, renderVariables } from "./logic";

describe("outreach input helpers", () => {
  it("accepts conventional email addresses and rejects malformed input", () => {
    expect(isValidEmail("person@example.com")).toBe(true);
    expect(isValidEmail("not an email")).toBe(false);
  });
  it("renders only known message variables", () => {
    expect(renderVariables("Hi {{ first_name }} at {{company}}", { first_name: "Ada", company: "Acme" })).toBe("Hi Ada at Acme");
    expect(renderVariables("Hi {{unknown}}", {})).toBe("Hi ");
  });
});
