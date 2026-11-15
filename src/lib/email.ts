/**
 * The one renderer behind both the composer's Preview tab and the mail that actually
 * goes out, so what is previewed is what is delivered.
 *
 * Input is never trusted: raw HTML in the markdown stays literal text, headings and
 * images are unavailable because a message from a person has neither, and the parsed
 * output passes through DOMPurify against an explicit allowlist. Styles are inlined
 * because the result is an email, and an email client has none of our stylesheet.
 */
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { missingVariables, renderVariables } from "./logic";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true }).disable(
  ["heading", "lheading", "image", "html_block", "html_inline"],
  true
);

/** Every element an email may contain, and the only attributes allowed from input. */
const TAGS = ["p", "br", "strong", "em", "a", "ul", "ol", "li", "blockquote", "code", "pre", "hr"];
const ATTRS = ["href"];

const SANS = "-apple-system,'Segoe UI',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const BASE = `font-family:${SANS};font-size:14px;line-height:1.6;color:#222`;

/**
 * Inline styles, keyed by tag, for the message that is actually sent. These are literal
 * colours on purpose: the output is an email payload for someone else's client, where
 * none of our tokens resolve. On screen the app's own stylesheet governs instead.
 */
const EMAIL_STYLES: Record<string, string> = {
  p: `${BASE};margin:0 0 12px`,
  a: "color:#1a5fb4;text-decoration:underline",
  strong: "font-weight:600",
  em: "font-style:italic",
  ul: `${BASE};margin:0 0 12px;padding-left:22px`,
  ol: `${BASE};margin:0 0 12px;padding-left:22px`,
  li: "margin:0 0 4px",
  blockquote: `${BASE};margin:0 0 12px;padding-left:12px;border-left:3px solid #ddd;color:#555`,
  code: `${MONO};background:#f4f4f5;border-radius:4px;padding:1px 4px`,
  pre: `${MONO};background:#f4f4f5;border-radius:4px;padding:12px;margin:0 0 12px`,
  hr: "border:0;border-top:1px solid #ddd;margin:16px 0",
};

// Runs over every element DOMPurify keeps: a link that is not http(s) or mailto loses
// its href, and every surviving link is marked external. Colours are not decided here —
// the delivered message takes them from EMAIL_STYLES, and the screen takes them from
// the app's stylesheet.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const element = node as Element;
  if (element.tagName?.toLowerCase() !== "a") return;
  const href = element.getAttribute("href") ?? "";
  if (!/^(https?:|mailto:)/i.test(href)) element.removeAttribute("href");
  element.setAttribute("rel", "noopener noreferrer");
});

/** Puts the email's own styles on every element. A light mail client has no stylesheet. */
function inlineStyles(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const style = EMAIL_STYLES[element.tagName.toLowerCase()];
    if (style) element.setAttribute("style", style);
  }
  return doc.body.innerHTML;
}

export type EmailParts = { html: string; text: string };

/** Marks a variable the message still asks for, so the preview can point at it. */
const MARK_START = "\u0001";
const MARK_END = "\u0002";
const MARKED = /\u0001([\w.]+)\u0002/g;

function sanitize(source: string): string {
  return DOMPurify.sanitize(markdown.render(source), { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS });
}

/**
 * The message as plain text: the syntax stripped, and a link read as `label (url)`.
 * Built from the same sanitized document as the HTML, so the two halves of the message
 * cannot drift apart.
 */
function toPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const inline = (node: Element): string => {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out += child.textContent ?? "";
      } else if (child.nodeType === 1) {
        const element = child as Element;
        const tag = element.tagName.toLowerCase();
        if (tag === "a") {
          const href = element.getAttribute("href");
          const label = inline(element);
          out += href ? `${label} (${href})` : label;
        } else {
          out += inline(element);
        }
      }
    }
    return out;
  };

  const blocks: string[] = [];
  for (const node of Array.from(doc.body.children)) {
    const tag = node.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      // A list is one block: its items belong together, not separated by blank lines.
      const items = Array.from(node.children).map((item, index) => {
        const marker = tag === "ol" ? `${index + 1}. ` : "- ";
        return marker + inline(item).replace(/\s+/g, " ").trim();
      });
      if (items.length) blocks.push(items.join("\n"));
    } else if (tag === "hr") {
      blocks.push("---");
    } else {
      const text = inline(node).replace(/[ \t]+/g, " ").trimEnd();
      if (text.trim()) blocks.push(text);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Renders markdown into the email that will be sent. `values` resolves `{{variables}}`
 * the way the campaign renderer does: the value, else the inline fallback, else nothing.
 *
 * `theme` decides what dresses the tags. The default, "email", inlines the email-safe
 * styles because a mail client has no stylesheet of ours; "app" inlines nothing and lets
 * the app's own stylesheet do it, which is what every on-screen copy of a message wants.
 * The text and the structure are identical either way.
 *
 * `highlightMissing` is for the preview alone — the variables the message still asks for
 * are wrapped in `.mdvar` so a sender can see what would go out blank. The send path
 * never sets it.
 */
export function renderEmailMarkdown(
  source: string,
  values: Record<string, string | undefined> = {},
  options: { highlightMissing?: boolean; theme?: "email" | "app" } = {}
): EmailParts {
  const clean = sanitize(renderVariables(source, values));
  const html = options.theme === "app" ? clean : inlineStyles(clean);
  if (!options.highlightMissing) return { html, text: toPlainText(clean) };

  const marked = { ...values };
  for (const key of missingVariables(source, values)) marked[key] = `${MARK_START}${key}${MARK_END}`;
  const flaggedClean = sanitize(renderVariables(source, marked));
  const flagged = options.theme === "app" ? flaggedClean : inlineStyles(flaggedClean);
  return {
    html: flagged.replace(MARKED, (_match, key: string) => `<span class="mdvar">{{${key}}}</span>`),
    text: toPlainText(clean),
  };
}

/**
 * The live preview: the same message, in the app's own colours. On screen the app's
 * stylesheet dresses the tags, so nothing is inlined and a message stays legible on the
 * dark surface; the text and structure are exactly what is sent.
 */
export function previewEmailMarkdown(
  source: string,
  values: Record<string, string | undefined> = {}
): string {
  return renderEmailMarkdown(source, values, { highlightMissing: true, theme: "app" }).html;
}

/**
 * Stored markup is never rendered straight: the Sent view and the reading pane put the
 * HTML a provider sent us through exactly the same allowlist. No styles are inlined —
 * a stranger's mail is shown in the app's colours like everything else.
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS });
}

/** The plain-text reading of stored HTML — what a reply quotes. */
export function emailHtmlToText(html: string): string {
  return toPlainText(sanitizeEmailHtml(html));
}

/**
 * A held message's body, from whichever half we have it in, dressed by the app. HTML a
 * provider sent goes through the allowlist; plain text goes through the markdown
 * renderer so it gets the same paragraphing as everything else.
 */
export function renderMessageBody(html?: string | null, text?: string | null): string {
  if (html?.trim()) return sanitizeEmailHtml(html);
  if (text?.trim()) return renderEmailMarkdown(text, {}, { theme: "app" }).html;
  return "";
}
