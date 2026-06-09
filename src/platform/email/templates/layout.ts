import type { TemplateDescriptor } from "./types";

/**
 * Branded, email-client-safe wrapper that every email renders inside.
 *
 * - Full HTML document (Microsoft Graph sendMail accepts full HTML).
 * - Table-based outer shell + a `<style>` block for content typography: the
 *   combination renders well in Outlook / OWA (the primary Yale clients) as well
 *   as Apple Mail and Gmail.
 * - `{{{ body }}}` is the raw (unescaped) slot where the per-email body is injected.
 *   `{{ subject }}` is available for the document title.
 *
 * Admins can fully edit this in /admin/email/templates (key "layout"); editing it
 * re-skins every platform email at once.
 */
const DEFAULT_LAYOUT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{ subject }}</title>
<style>
  body { margin: 0; padding: 0; background-color: #f1f5f9; }
  .email-content { color: #1e293b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; }
  .email-content h1 { font-size: 22px; line-height: 1.3; margin: 0 0 14px; color: #0f172a; }
  .email-content h2 { font-size: 18px; line-height: 1.3; margin: 22px 0 10px; color: #0f172a; }
  .email-content h3 { font-size: 16px; line-height: 1.3; margin: 18px 0 8px; color: #0f172a; }
  .email-content p { margin: 0 0 14px; }
  .email-content ul, .email-content ol { margin: 0 0 14px; padding-left: 22px; }
  .email-content li { margin: 0 0 6px; }
  .email-content a { color: #00356b; text-decoration: underline; }
  .email-content blockquote { margin: 0 0 14px; padding: 8px 16px; border-left: 3px solid #cbd5e1; color: #475569; }
  .email-content hr { border: none; border-top: 1px solid #e2e8f0; margin: 22px 0; }
  .email-content strong { font-weight: 600; }
</style>
</head>
<body>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f1f5f9;">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
        <tr>
          <td style="background-color: #00356b; padding: 20px 32px;">
            <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 700; color: #ffffff; letter-spacing: 0.3px;">HAVEN Free Clinic</span>
          </td>
        </tr>
        <tr>
          <td class="email-content" style="padding: 32px;">
            {{{ body }}}
          </td>
        </tr>
        <tr>
          <td style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0;">
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5; color: #64748b;">
              HAVEN Free Clinic &middot; Yale School of Medicine<br>
              This is an automated message from the HAVEN Hub platform.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

export const layoutDescriptor: TemplateDescriptor = {
  key: "layout",
  name: "Shared layout wrapper",
  category: "layout",
  variables: [
    {
      name: "body",
      label: "Rendered email body (HTML)",
      sampleValue:
        "<h2>Welcome to HAVEN</h2><p>Hi Sam,</p><p>This is what a formatted message looks like. You can use <strong>bold text</strong>, <a href=\"https://example.com\">links</a>, and lists:</p><ul><li>First item</li><li>Second item</li></ul><p>Thanks,<br>The HAVEN Team</p>",
    },
    { name: "subject", label: "Email subject", sampleValue: "Welcome to HAVEN" },
  ],
  defaultSubject: "{{ subject }}",
  defaultBody: DEFAULT_LAYOUT,
};
