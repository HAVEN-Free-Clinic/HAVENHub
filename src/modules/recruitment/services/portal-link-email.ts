// src/modules/recruitment/services/portal-link-email.ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Magic-link email body. Plain transactional HTML, matching the inline-html
 *  pattern used by the other recruitment emails. */
export function portalLinkEmail(input: { firstName?: string; url: string }): { subject: string; html: string } {
  const hi = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi there,";
  return {
    subject: "Your HAVEN Hub application link",
    html: `<p>${hi}</p><p>Use this link to access your HAVEN Hub application. It expires in 30 minutes and can be used once.</p><p><a href="${escapeHtml(input.url)}">Open my application</a></p><p>If you did not request this, you can ignore this email.</p>`,
  };
}
