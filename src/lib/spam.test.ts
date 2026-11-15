import { describe, expect, it } from "vitest";
import { levelOf, scoreMessage } from "./spam";

describe("message spam score", () => {
  it("leaves a short, plain, opt-out-bearing message nearly clean", () => {
    const { score, level, flags } = scoreMessage(
      "Quick question about your onboarding",
      "Hi Ada,\n\nI noticed Acme just opened a London office. Worth a short chat?\n\nNot interested? Just reply stop.\n\n— Sam"
    );
    expect(flags.map((flag) => flag.id)).not.toContain("optout");
    expect(score).toBeLessThan(15);
    expect(level).toBe("clean");
  });

  it("flags the classic promotional tells", () => {
    const { score, flags } = scoreMessage(
      "FREE OFFER ACT NOW",
      "CLICK HERE for a 100% guarantee! Buy now! Limited time risk-free money back!!!"
    );
    const ids = flags.map((flag) => flag.id);
    expect(ids).toContain("triggers");
    expect(ids).toContain("bangs");
    expect(ids).toContain("subject-caps");
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("penalises link shorteners more than ordinary links", () => {
    const shortened = scoreMessage("Hi", "Read this https://bit.ly/abc123 and reply stop.").score;
    const normal = scoreMessage("Hi", "Read this https://acme.com/pricing and reply stop.").score;
    expect(shortened).toBeGreaterThan(normal);
  });

  it("warns about a variable that would send blank", () => {
    const { flags } = scoreMessage("Hi {{first_name}}", "Body with {{company}} in it. Reply stop to opt out.");
    expect(flags.map((flag) => flag.id)).toContain("variables");
  });

  it("does not count a variable that will be filled in", () => {
    const body = "Hi {{first_name}}, a thought for {{company}}. Reply stop to opt out.";
    // A fallback alone is enough: the copy is complete without any lead behind it.
    expect(scoreMessage("Hi {{first_name|there}}", "One line. Reply stop to opt out.").level).toBe("clean");
    expect(scoreMessage("Hi {{first_name}}", body, { first_name: "Ada", company: "Acme" }).flags.map((f) => f.id)).not.toContain(
      "variables"
    );
    // Only the one that stays empty is named.
    const { flags } = scoreMessage("Hi {{first_name}} {{company}}", "One line. Reply stop to opt out.", {
      first_name: "Ada",
    });
    const flag = flags.find((one) => one.id === "variables");
    expect(flag?.detail).toContain("{{company}}");
    expect(flag?.detail).not.toContain("{{first_name}}");
  });

  it("saturates for an obviously spammy message and never exceeds 100", () => {
    const { score, level } = scoreMessage(
      "FREE CASH WINNER!!!",
      "FREE FREE FREE !!! 100% GUARANTEE $$$$ https://bit.ly/x Act now! Buy now!!! ".repeat(5)
    );
    expect(score).toBeGreaterThanOrEqual(60);
    expect(score).toBeLessThanOrEqual(100);
    expect(level).toBe("spammy");
    expect(levelOf(0)).toBe("clean");
    expect(levelOf(100)).toBe("spammy");
  });
});
