/**
 * The message-side half of the spam tooling: a local, heuristic read of what a mail
 * client's filter tends to punish. It is deliberately explainable — every point comes
 * from a named flag with the exact thing that tripped it, so the score can be acted on
 * rather than just distrusted.
 *
 * The score is a risk: 0 is clean and 100 is almost certainly filtered. Nothing here
 * sends anything anywhere; it is the same judgement a recipient's filter makes, guessed
 * from the text.
 */

import { missingVariables } from "./logic";

export type SpamLevel = "clean" | "watch" | "risky" | "spammy";

export type SpamFlag = {
  id: string;
  label: string;
  /** What in the message tripped it — the words, the count, the link. */
  detail: string;
  weight: number;
};

export type SpamScore = {
  /** 0–100; lower is better. */
  score: number;
  level: SpamLevel;
  flags: SpamFlag[];
};

export const LEVEL_LABEL: Record<SpamLevel, string> = {
  clean: "Clean",
  watch: "Watch",
  risky: "Risky",
  spammy: "Spammy",
};

export function levelOf(score: number): SpamLevel {
  if (score < 15) return "clean";
  if (score < 35) return "watch";
  if (score < 60) return "risky";
  return "spammy";
}

/** Words and phrases that filters weigh against a message. Matched case-insensitively. */
const TRIGGER_WORDS = [
  "free",
  "guarantee",
  "guaranteed",
  "act now",
  "limited time",
  "risk-free",
  "risk free",
  "click here",
  "buy now",
  "money back",
  "winner",
  "no obligation",
  "credit card",
  "make money",
  "earn money",
  "100%",
  "lowest price",
  "dear friend",
  "double your",
  "extra income",
  "work from home",
  "offer expires",
  "why pay more",
  "congratulations",
  "viagra",
  "casino",
  "loan",
  "debt",
];

const SHORTENERS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "is.gd",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
];

const OPT_OUT = /(unsubscribe|opt[- ]?out|stop receiving|reply stop)/i;

/**
 * Reads a written message — its subject and its body, before any quoted original is
 * appended — and returns the risk score with the reasons behind it.
 *
 * `values` is what the variables would be filled from, the same map the preview uses. A
 * variable that resolves is not a fault in the copy, so only one that would land blank is
 * counted against it.
 */
export function scoreMessage(
  subject: string,
  body: string,
  values: Record<string, string | undefined> = {}
): SpamScore {
  const flags: SpamFlag[] = [];
  const add = (id: string, label: string, detail: string, weight: number) =>
    flags.push({ id, label, detail, weight });

  const text = `${subject}\n${body}`;
  const lower = text.toLowerCase();

  // Shouting.
  const caps = text.match(/\b[A-Z]{3,}\b/g) ?? [];
  if (caps.length >= 3) {
    add("caps", "Shouting", `${caps.length} words in capitals — ${caps.slice(0, 4).join(", ")}`, 12);
  } else if (caps.length > 0) {
    add("caps", "Some capitals", caps.join(", "), 5);
  }

  // Punctuation.
  const bangs = (text.match(/!/g) ?? []).length;
  if (bangs >= 3) add("bangs", "Too many exclamation marks", `${bangs} in the message`, 8);
  else if (bangs === 2) add("bangs", "Exclamation marks", "2 in the message", 4);
  if (/[!?]{3,}/.test(text)) add("punctuation", "Repeated punctuation", "e.g. !!! or ???", 6);

  // Money and claims.
  if (/[$€£]\s?\d/.test(text) || /\b\d+\s?%/.test(text)) {
    add("money", "Money in the copy", "Amounts or percentages read as a promotion", 6);
  }

  // Trigger words.
  const triggers = TRIGGER_WORDS.filter((word) => lower.includes(word));
  if (triggers.length >= 3) {
    add("triggers", "Spam trigger words", triggers.slice(0, 6).join(", "), 14);
  } else if (triggers.length > 0) {
    add("triggers", "Trigger word", triggers.join(", "), 7);
  }

  // Links.
  const links = body.match(/https?:\/\/[^\s)]+/gi) ?? [];
  const shorteners = links.filter((link) => SHORTENERS.some((host) => link.toLowerCase().includes(host)));
  if (shorteners.length > 0) {
    add("shortener", "Link shortener", shorteners.join(", "), 14);
  } else if (links.length > 2) {
    add("links", "Many links", `${links.length} links in the message`, 8);
  }

  // Cold outreach should always offer a way out.
  if (body.trim() && !OPT_OUT.test(body)) {
    add("optout", "No opt-out line", "An outreach message should offer a way out", 10);
  }

  // The subject.
  const trimmed = subject.trim();
  if (trimmed.length > 70) add("subject-length", "Long subject", `${trimmed.length} characters (keep under ~60)`, 5);
  if (trimmed && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    add("subject-caps", "Subject in capitals", trimmed, 8);
  }

  // A variable only costs points when nothing will fill it in: no value for the lead it is
  // going to, and no inline fallback. Writing {{first_name}} is the point of a template, so
  // it cannot be what makes a template look like spam.
  const unresolved = missingVariables(text, values);
  if (unresolved.length > 0) {
    add(
      "variables",
      "Unresolved variable",
      `${unresolved.map((key) => `{{${key}}}`).join(", ")} ${unresolved.length === 1 ? "sends" : "send"} blank`,
      6
    );
  }

  const score = Math.min(100, flags.reduce((total, flag) => total + flag.weight, 0));
  return { score, level: levelOf(score), flags };
}
