// src/platform/notifications/render.test.ts
import { describe, it, expect } from "vitest";
import { renderTeamsBody } from "./render";

describe("renderTeamsBody", () => {
  it("renders title, summary, and a link", () => {
    const html = renderTeamsBody({
      title: "HIPAA compliance reminder",
      summary: "Your training is expiring soon.",
      link: "https://hub.example.com/compliance",
    });
    expect(html).toContain("<strong>HIPAA compliance reminder</strong>");
    expect(html).toContain("Your training is expiring soon.");
    expect(html).toContain('href="https://hub.example.com/compliance"');
    expect(html).toContain("Open in HAVEN Hub");
  });

  it("omits the link block when no link is given", () => {
    const html = renderTeamsBody({ title: "T", summary: "S" });
    expect(html).not.toContain("<a ");
  });

  it("escapes HTML in title and summary", () => {
    const html = renderTeamsBody({ title: "<b>x</b>", summary: "a & b <c>" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a &amp; b &lt;c&gt;");
  });
});
