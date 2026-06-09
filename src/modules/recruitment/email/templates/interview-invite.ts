function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Candidate interview invitation. Notification-only; manual scheduling (no
 *  calendar integration). User-supplied values are HTML-escaped. */
export function interviewInviteEmail(input: {
  firstName: string;
  departmentName: string;
  scheduledAt: Date;
  zoomLink: string | null;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const dept = escapeHtml(input.departmentName);
  const when = escapeHtml(
    input.scheduledAt.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "America/New_York" })
  );
  const zoom = input.zoomLink
    ? `<a href="${escapeHtml(input.zoomLink)}">${escapeHtml(input.zoomLink)}</a>`
    : "link to follow";
  return {
    subject: `HAVEN ${input.departmentName} director interview`,
    html: `<p>Hi ${name},</p><p>You're invited to a director interview for <strong>${dept}</strong> at HAVEN Free Clinic.</p><p>Time: ${when}<br/>Join: ${zoom}</p><p>Please reply if you need to reschedule.</p>`,
  };
}
