// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { previewEmailMarkdown, renderEmailMarkdown, renderMessageBody, sanitizeEmailHtml } from "./email";

describe("email markdown rendering", () => {
  it("leaves raw HTML as literal text instead of rendering it", () => {
    const { html } = renderEmailMarkdown("Hello <script>alert(1)</script> there");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps only the tags an email may carry", () => {
    expect(renderEmailMarkdown("## A heading").html).not.toContain("<h2");
    expect(renderEmailMarkdown("![shot](https://a.com/x.png)").html).not.toContain("<img");
    expect(renderEmailMarkdown("**bold** and *italic*").html).toContain("<strong");
    expect(renderEmailMarkdown("- one\n- two").html).toContain("<ul");
    expect(renderEmailMarkdown("---").html).toContain("<hr");
  });

  it("marks links external and drops any other scheme", () => {
    const linked = renderEmailMarkdown("[Acme](https://acme.com)").html;
    expect(linked).toContain('href="https://acme.com"');
    expect(linked).toContain('rel="noopener noreferrer"');

    // The parser refuses to link a script URL, so it arrives as literal text.
    expect(renderEmailMarkdown("[x](javascript:alert(1))").html).not.toContain("href");

    // Markup that arrived from a provider is where a bad scheme actually has to be
    // stripped, and the link that remains is still marked external.
    const stored = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(stored).not.toContain("javascript:");
    expect(stored).toContain('rel="noopener noreferrer"');
  });

  it("styles every tag inline, because an email client has no stylesheet", () => {
    const { html } = renderEmailMarkdown("Hi");
    expect(html).toContain("style=");
    expect(html).toContain("line-height:1.6");
  });

  it("inlines nothing for the screen, where the app's own stylesheet dresses the tags", () => {
    expect(previewEmailMarkdown("# not a heading\n\n**Hi**")).not.toContain("style=");
    expect(renderMessageBody(null, "Hi")).not.toContain("style=");
  });

  it("renders the plain-text alternative with links as text (url)", () => {
    const { text } = renderEmailMarkdown("See [Acme](https://acme.com) for more.");
    expect(text).toBe("See Acme (https://acme.com) for more.");
  });

  it("lists the plain-text alternative too", () => {
    const { text } = renderEmailMarkdown("Steps:\n\n- first\n- second");
    expect(text).toBe("Steps:\n\n- first\n- second");
  });

  it("resolves variables, falling back the way the campaign renderer does", () => {
    const { html } = renderEmailMarkdown("Hi {{first_name|there}}", { first_name: "Ada" });
    expect(html).toContain("Ada");
    expect(renderEmailMarkdown("Hi {{first_name|there}}", {}).html).toContain("there");
  });

  it("shares one pipeline between the preview and the delivered html", () => {
    const values = { first_name: "Ada" };
    const { html } = renderEmailMarkdown("Hi **{{first_name}}**", values);
    const preview = previewEmailMarkdown("Hi **{{first_name}}**", values);
    // One message: only the dressing differs, because a mail client has none of our
    // stylesheet and the app does.
    const bare = (markup: string) => markup.replace(/ style="[^"]*"/g, "");
    expect(bare(preview)).toBe(bare(html));
    expect(preview).toContain("<strong>Ada</strong>");

    // Only the preview calls out a variable that has nothing to resolve it.
    const flagged = previewEmailMarkdown("Hi {{first_name}}", {});
    expect(flagged).toContain('class="mdvar"');
    expect(flagged).toContain("{{first_name}}");
    expect(renderEmailMarkdown("Hi {{first_name}}", {}).html).not.toContain("mdvar");
  });

  it("sanitizes markup that arrived from a provider", () => {
    const clean = sanitizeEmailHtml('<p onclick="steal()">Hi</p><style>body{display:none}</style>');
    expect(clean).toContain("<p");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("<style");
  });
});
