function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Onboarding email carrying the tokenized contract link. Plan 11's acceptance
 *  email is separate and unchanged; this is the "complete your contract" step. */
export function onboardingEmail(input: {
  firstName: string;
  cycleTitle: string;
  contractUrl: string;
}): { subject: string; html: string } {
  const name = escapeHtml(input.firstName) || "there";
  const cycle = escapeHtml(input.cycleTitle);
  const url = escapeHtml(input.contractUrl);
  return {
    subject: `Complete your HAVEN onboarding for ${input.cycleTitle}`,
    html: `<p>Congratulations ${name},</p><p>To finish joining HAVEN for ${cycle}, please complete your onboarding contract here: <a href="${url}">${url}</a></p><p>It collects your signatures, EPIC access details, and HIPAA certificate.</p>`,
  };
}
