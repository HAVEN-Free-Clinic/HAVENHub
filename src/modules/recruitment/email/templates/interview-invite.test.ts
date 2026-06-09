import { describe, expect, it } from "vitest";
import { interviewInviteEmail } from "./interview-invite";

describe("interviewInviteEmail", () => {
  it("names the candidate, department, time, and zoom link", () => {
    const { subject, html } = interviewInviteEmail({
      firstName: "Ada", departmentName: "Education", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://zoom.us/j/123",
    });
    expect(subject).toContain("Education");
    expect(html).toContain("Ada");
    expect(html).toContain("https://zoom.us/j/123");
    expect(html).toContain("2026");
  });
  it("escapes HTML in user-supplied values and has no em-dash", () => {
    const { subject, html } = interviewInviteEmail({ firstName: "<b>X</b>", departmentName: "R & D", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: "https://z" });
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&amp;");
    expect(subject).not.toContain("—");
    expect(html).not.toContain("—");
  });
  it("handles a missing zoom link", () => {
    const { html } = interviewInviteEmail({ firstName: "A", departmentName: "D", scheduledAt: new Date("2026-04-15T18:30:00Z"), zoomLink: null });
    expect(html).toContain("link to follow");
  });
});
