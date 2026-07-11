import juice from "juice";

/**
 * Inline the layout's `<style>` rules onto each element and strip the `<style>`
 * block from a fully-rendered email.
 *
 * Every platform email is wrapped in a full HTML document whose typography lives
 * in a `<head><style>` block (see templates/layout.ts). Gmail's conversation view
 * clips messages that carry an embedded `<style>` block behind
 * "[Message clipped] / View entire message" -- even a ~9 KB message with nothing
 * hidden -- because it strips and re-scopes the `<style>` and treats the remainder
 * as clipped. Inlining every rule and removing the `<style>` block keeps the
 * identical rendered look while removing the structure that triggers the clip. It
 * is also the email-client-safe form (Outlook/OWA strip `<style>` too), so it
 * improves rendering everywhere, not only in Gmail.
 *
 * Applied at the transport boundary (GraphTransport.send), which is the single
 * seam every real send funnels through -- queue drain, admin test-send, and
 * notification email. Doing it there (rather than at render time) keeps the
 * rendered/stored HTML untouched (so template golden tests and admin previews are
 * unaffected) and still fixes the admin-editable DB layout override, which also
 * ships a `<style>` block. On markup with no `<style>` block it is a no-op.
 *
 * Defensive: an inliner failure must never block a send (a password-reset or
 * magic-link email arriving un-inlined and possibly clipped beats not arriving),
 * so on any error we fall back to the original HTML.
 */
export function inlineEmailHtml(html: string): string {
  try {
    // removeStyleTags (juice default: true) is the load-bearing option here --
    // it deletes the `<style>` block after inlining, which is what removes the
    // Gmail clip trigger. Set explicitly so a future juice default change is safe.
    return juice(html, { removeStyleTags: true });
  } catch (error) {
    console.warn(
      `[email] CSS inlining failed; sending un-inlined HTML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return html;
  }
}
