import { describe, it, expect } from "vitest";
import { inlineEmailHtml } from "@/platform/email/render/inline";
import { renderTemplate } from "@/platform/email/render/render";
import { layoutDescriptor } from "@/platform/email/templates/layout";

/** Render the real shared layout the way the send pipeline does. */
function renderRealLayout(): string {
  return renderTemplate(layoutDescriptor.defaultBody, {
    brandColor: "#00356b",
    subject: "Your HAVEN Hub application link",
    body:
      '<p>Hi there,</p><p>Use this ' +
      '<a href="https://hub.example/apply">link</a>.</p>' +
      "<p>Thanks, <strong>HAVEN</strong>.</p>",
  });
}

describe("inlineEmailHtml", () => {
  it("removes the <style> block that triggers Gmail's [Message clipped]", () => {
    const raw = renderRealLayout();
    // precondition: the shared layout ships a <style> block
    expect(raw).toMatch(/<style[\s>]/i);

    const out = inlineEmailHtml(raw);
    expect(out).not.toMatch(/<style[\s>]/i);
  });

  it("preserves the brand link color as an inline style on <a>", () => {
    const out = inlineEmailHtml(renderRealLayout());
    expect(out).toMatch(/<a\b[^>]*style="[^"]*color:\s*#00356b/i);
  });

  it("inlines content typography (paragraph margins) onto body tags", () => {
    const out = inlineEmailHtml(renderRealLayout());
    expect(out).toMatch(/<p\b[^>]*style="[^"]*margin:/i);
  });

  it("merges inlined rules with the element's existing inline style", () => {
    const out = inlineEmailHtml(renderRealLayout());
    // the content cell keeps its authored `padding: 32px` and gains the inlined font
    expect(out).toMatch(/class="email-content"[^>]*style="[^"]*padding:\s*32px/i);
    expect(out).toMatch(/class="email-content"[^>]*style="[^"]*font-family/i);
  });

  it("returns HTML unchanged when there is nothing to inline", () => {
    const plain = "<p>no styles here</p>";
    expect(inlineEmailHtml(plain)).toContain("no styles here");
  });
});
