function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Notification-only acceptance email (Plan 11). The onboarding/contract link is
 *  added in Plan 13; this email only congratulates and names the department. */
export function acceptanceEmail(input: {
  firstName: string;
  cycleTitle: string;
  departmentName: string;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const dept = escapeHtml(input.departmentName);
  const cycle = escapeHtml(input.cycleTitle);
  return {
    subject: `You've been accepted to HAVEN: ${input.departmentName}`,
    html: `<p>Congratulations ${name},</p><p>You've been accepted into <strong>${dept}</strong> for ${cycle}. We'll follow up shortly with onboarding next steps.</p>`,
  };
}
